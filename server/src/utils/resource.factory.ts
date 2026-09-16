import { Router, type Request, type Response } from 'express';
import type { Model, FilterQuery, SortOrder } from 'mongoose';
import { AppError, asyncHandler, sendOk } from './response.js';
import { filtroPorId } from './mongoId.js';

/**
 * Fabrica de rutas CRUD para una coleccion.
 *
 * Evita escribir ~35 endpoints a mano: cada coleccion declara que campos se
 * pueden filtrar y ordenar, y la fabrica arma el GET de lista, el GET por id
 * y (opcionalmente) el POST y el PATCH.
 *
 * Los query params son los MISMOS para todas las colecciones, para que la capa
 * de adaptacion del frontend (nexus-data.js) traduzca
 * query(where(), orderBy(), limit()) sin casos especiales:
 *
 *   ?<campo>=valor  &q=texto  &desde=ISO  &hasta=ISO
 *   &limit=50       &offset=0 &sort=campo &order=asc|desc
 */
export interface OpcionesRecurso<TDoc> {
  coleccion: string;
  modelo: Model<TDoc>;
  /** Campos habilitados como filtro exacto por query param. */
  filtros?: readonly string[];
  /** Campos habilitados para ordenar. */
  ordenables?: readonly string[];
  /** Campo de texto donde aplica el parametro libre `q`. */
  campoBusqueda?: string;
  /** Campo de fecha para `desde` / `hasta`. */
  campoFecha?: string;
  /** Orden por defecto cuando no se pide ninguno. */
  ordenPorDefecto?: string;
  /** Coleccion solo lectura: no expone POST ni PATCH. */
  soloLectura?: boolean;
  /** Campos que NUNCA se devuelven al cliente (ej: passwordHash). */
  excluir?: readonly string[];
  /** Campos que el cliente NUNCA puede escribir, aunque los mande. */
  noEscribible?: readonly string[];
  /** Tope de documentos por respuesta (default 500). */
  limiteMaximo?: number;
}

const LIMITE_POR_DEFECTO = 50;
const LIMITE_MAXIMO_POR_DEFECTO = 500;

const parsearEntero = (valor: unknown, porDefecto: number, maximo: number): number => {
  const n = Number(valor);
  if (!Number.isFinite(n) || n < 0) return porDefecto;
  return Math.min(Math.trunc(n), maximo);
};

const escaparRegex = (texto: string): string => texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Normaliza el valor de un query param a una lista de strings.
 *
 * Es la defensa contra la inyeccion de operadores NoSQL. Express usa el parser
 * `qs` (extended), asi que `?rol[$ne]=admin` NO llega como texto: llega como el
 * OBJETO `{ $ne: 'admin' }`. Si ese objeto se asignara al filtro, Mongo lo
 * interpretaria como operador y el cliente podria saltarse cualquier condicion.
 * Filtrando solo valores `string`, un objeto no sobrevive y el campo
 * simplemente no se filtra.
 *
 * Soporta las dos formas de repetir un campo:
 *   ?sucursal=Centro&sucursal=Este   y   ?sucursal=Centro,Este
 */
const aValoresEscalares = (valor: unknown): string[] => {
  const lista = Array.isArray(valor) ? valor : [valor];
  return lista
    .filter((item): item is string => typeof item === 'string')
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter((item) => item !== '');
};

/**
 * Arma el filtro de MongoDB a partir de los query params.
 * Solo se aceptan los campos declarados en `filtros`: cualquier otro se ignora,
 * asi un cliente no puede filtrar por un campo interno.
 */
export const construirFiltro = <TDoc>(
  query: Request['query'],
  opts: Pick<OpcionesRecurso<TDoc>, 'filtros' | 'campoBusqueda' | 'campoFecha'>,
): FilterQuery<TDoc> => {
  const filtro: Record<string, unknown> = {};

  for (const campo of opts.filtros ?? []) {
    const valores = aValoresEscalares(query[campo]);
    if (valores.length === 0) continue;
    filtro[campo] = valores.length === 1 ? valores[0] : { $in: valores };
  }

  if (opts.campoBusqueda !== undefined && typeof query['q'] === 'string' && query['q'].trim() !== '') {
    filtro[opts.campoBusqueda] = { $regex: escaparRegex(query['q'].trim()), $options: 'i' };
  }

  if (opts.campoFecha !== undefined) {
    const rango: Record<string, Date> = {};
    const desde = query['desde'];
    const hasta = query['hasta'];
    if (typeof desde === 'string') {
      const d = new Date(desde);
      if (!Number.isNaN(d.getTime())) rango['$gte'] = d;
    }
    if (typeof hasta === 'string') {
      const h = new Date(hasta);
      if (!Number.isNaN(h.getTime())) rango['$lte'] = h;
    }
    if (Object.keys(rango).length > 0) filtro[opts.campoFecha] = rango;
  }

  return filtro as FilterQuery<TDoc>;
};

/**
 * Arma el ordenamiento. Si el campo pedido no esta en `ordenables` se usa el
 * orden por defecto, para que un cliente no fuerce un sort sin indice.
 */
export const construirOrden = <TDoc>(
  query: Request['query'],
  opts: Pick<OpcionesRecurso<TDoc>, 'ordenables' | 'ordenPorDefecto'>,
): Record<string, SortOrder> => {
  const pedido = query['sort'];
  const dir: SortOrder = query['order'] === 'asc' ? 1 : -1;
  if (typeof pedido === 'string' && (opts.ordenables ?? []).includes(pedido)) {
    return { [pedido]: dir };
  }
  const porDefecto = opts.ordenPorDefecto;
  return porDefecto !== undefined ? { [porDefecto]: dir } : {};
};

/** Crea el router CRUD de una coleccion. */
export const crearRecurso = <TDoc>(opts: OpcionesRecurso<TDoc>): Router => {
  const router = Router();
  const limiteMaximo = opts.limiteMaximo ?? LIMITE_MAXIMO_POR_DEFECTO;

  // Proyeccion de exclusion: '-passwordHash -otroCampo'. Si no hay, se
  // devuelve el documento completo.
  const proyeccion = (opts.excluir ?? []).map((c) => `-${c}`).join(' ');

  /** Quita los campos que el cliente no puede escribir. */
  const limpiarCuerpo = (cuerpo: unknown): Record<string, unknown> => {
    const fuente = (cuerpo ?? {}) as Record<string, unknown>;
    const prohibidos = opts.noEscribible ?? [];
    if (prohibidos.length === 0) return fuente;
    const limpio: Record<string, unknown> = { ...fuente };
    for (const campo of prohibidos) delete limpio[campo];
    return limpio;
  };

  /**
   * Quita de la respuesta los campos excluidos.
   *
   * Hace falta si o si en POST y PATCH: la proyeccion `select('-campo')` solo se
   * aplica en las consultas de lectura, no al documento que devuelve
   * `create()` ni `findByIdAndUpdate()`. Sin esto, un PATCH con cuerpo vacio
   * sobre /credit-pins devolvia el PIN del cliente en texto plano, aunque
   * `excluir` lo declarara oculto.
   */
  const ocultar = <TDocRespuesta>(doc: TDocRespuesta): TDocRespuesta => {
    const excluidos = opts.excluir ?? [];
    if (excluidos.length === 0) return doc;
    const plano = doc as Record<string, unknown>;
    for (const campo of excluidos) delete plano[campo];
    return doc;
  };

  // GET / -> lista paginada
  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const filtro = construirFiltro<TDoc>(req.query, opts);
      const orden = construirOrden<TDoc>(req.query, opts);
      const limit = parsearEntero(req.query['limit'], LIMITE_POR_DEFECTO, limiteMaximo);
      const offset = parsearEntero(req.query['offset'], 0, Number.MAX_SAFE_INTEGER);

      const consulta = opts.modelo.find(filtro).sort(orden).skip(offset).limit(limit).lean();
      const [datos, total] = await Promise.all([
        proyeccion === '' ? consulta.exec() : consulta.select(proyeccion).exec(),
        opts.modelo.countDocuments(filtro).exec(),
      ]);

      sendOk(res, { items: datos, total, limit, offset, coleccion: opts.coleccion });
    }),
  );

  // GET /:id -> un documento
  router.get(
    '/:id',
    asyncHandler(async (req: Request, res: Response) => {
      // findOne(filtroPorId(...)) y no findById: el frontend manda ids de
      // Firestore (20 caracteres) que no son ObjectId, y findById tiraba
      // CastError con ellos.
      const consulta = opts.modelo.findOne(filtroPorId(String(req.params.id))).lean();
      const doc = await (proyeccion === '' ? consulta.exec() : consulta.select(proyeccion).exec());
      if (doc === null) {
        throw new AppError(`No existe el documento ${String(req.params.id)} en ${opts.coleccion}`, 404, 'NOT_FOUND');
      }
      sendOk(res, doc);
    }),
  );

  if (opts.soloLectura !== true) {
    router.post(
      '/',
      asyncHandler(async (req: Request, res: Response) => {
        const creado = await opts.modelo.create(limpiarCuerpo(req.body));
        // toObject() antes de ocultar: el documento de Mongoose no se puede
        // mutar sin ensuciar la instancia.
        sendOk(res, ocultar(creado.toObject() as unknown as Record<string, unknown>), 201);
      }),
    );

    router.patch(
      '/:id',
      asyncHandler(async (req: Request, res: Response) => {
        const actualizado = await opts.modelo
          .findOneAndUpdate(
            filtroPorId(String(req.params.id)),
            { $set: limpiarCuerpo(req.body) },
            { new: true, runValidators: true },
          )
          .lean()
          .exec();
        if (actualizado === null) {
          throw new AppError(`No existe el documento ${String(req.params.id)} en ${opts.coleccion}`, 404, 'NOT_FOUND');
        }
        sendOk(res, ocultar(actualizado as unknown as Record<string, unknown>));
      }),
    );
  }

  return router;
};
