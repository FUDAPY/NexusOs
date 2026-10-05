import { InventoryMovement, Product, type ProductDocument } from '../models/index.js';
import { AppError } from '../utils/response.js';
import { withTransaction } from '../utils/withTransaction.js';
import { recordAudit } from './audit.service.js';

export type ModoAjuste = 'agregar' | 'restar' | 'establecer';

export interface AjusteSolicitado {
  producto: string;
  codigo?: string;
  cantidad: number;
  modo?: ModoAjuste;
  motivo?: string;
}

export interface AjusteSolicitud {
  ajustes: AjusteSolicitado[];
  sucursal?: string;
  origen?: string;
  usuario?: string;
  usuarioRol?: string;
  canal?: string;
  idempotencyKey?: string;
}

export interface AjusteAplicado {
  productoId: string;
  codigo: string;
  nombre: string;
  modo: ModoAjuste;
  cantidad: number;
  stockAnterior: number;
  stockResultante: number;
  agotado: boolean;
  movimientoId: string;
}

export interface AjusteRespuesta {
  replayed: boolean;
  resultados: AjusteAplicado[];
}

interface Contexto {
  ip: string;
  userAgent: string;
}

const escaparRegex = (texto: string): string => texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* Resuelve el producto escrito por el usuario. Prioriza coincidencia exacta; si
   no hay, devuelve los mas parecidos para que el bot pregunte en vez de adivinar.
   Cargar mercaderia en el producto equivocado no se detecta solo. */
const resolverProducto = async (texto: string, sucursal: string): Promise<ProductDocument[]> => {
  const limpio = texto.trim();
  if (limpio === '') return [];

  const exacto = await Product.find({
    $or: [{ nombre: limpio }, { codigo: limpio }],
  }).limit(5).exec();

  if (exacto.length > 0) return exacto;

  /* Entre productos activos y, si se indica sucursal, solo los de esa sucursal
     o los unificados. */
  const filtro: Record<string, unknown> = { estado: 'Activo' };
  if (sucursal !== '') {
    filtro.$or = [{ sucursal }, { sucursal: 'Unificado' }, { sucursal: { $in: ['', null] } }];
  }

  return Product.find({
    ...filtro,
    nombre: { $regex: escaparRegex(limpio), $options: 'i' },
  }).limit(6).exec();
};

export const consultarStock = async (
  texto: string,
  sucursal: string,
): Promise<{
  items: {
    id: string; codigo: string; nombre: string;
    stock: number; stockMinimo: number; agotado: boolean; sucursal: string;
  }[];
}> => {
  const productos = await resolverProducto(texto, String(sucursal ?? '').trim());

  return {
    items: productos.map((p) => ({
      id: String(p._id),
      codigo: p.codigo ?? '',
      nombre: p.nombre,
      stock: Number(p.stock ?? 0),
      stockMinimo: Number(p.stockMinimo ?? 0),
      agotado: p.agotado === true,
      sucursal: p.sucursal ?? 'Unificado',
    })),
  };
};

/* Aplica el ajuste. Todo el movimiento del stock ocurre dentro de la transaccion.
   Un egreso no puede dejar el saldo en negativo: a diferencia de produccion, el
   inventario no admite negativos. */
export const ajustarStock = async (
  solicitud: AjusteSolicitud,
  contexto: Contexto,
): Promise<AjusteRespuesta> => {
  const lista = Array.isArray(solicitud.ajustes) ? solicitud.ajustes : [];
  if (lista.length === 0) throw new AppError('No se envio ningun ajuste', 400, 'AJUSTES_VACIOS');
  if (lista.length > 50) throw new AppError('Demasiados ajustes en una llamada', 400, 'AJUSTES_EXCESIVOS');

  const clave = String(solicitud.idempotencyKey ?? '').trim();
  const sucursal = String(solicitud.sucursal ?? '').trim();

  /* Reintento de WhatsApp: si la clave ya se aplico se devuelve el resultado
     original. Sin esto, un mensaje duplicado carga la mercaderia dos veces. */
  if (clave !== '') {
    const previo = await InventoryMovement.findOne({ idempotencyKey: clave }).lean().exec();
    if (previo) {
      const detalle = (previo.detalle ?? []) as unknown as AjusteAplicado[];
      return { replayed: true, resultados: detalle };
    }
  }

  const resultados = await withTransaction(async (session) => {
    const opciones = session ? { session } : {};
    const aplicados: AjusteAplicado[] = [];
    const movimientos: Record<string, unknown>[] = [];

    for (const item of lista) {
      const cantidad = Math.trunc(Number(item.cantidad));
      if (!Number.isFinite(cantidad) || cantidad <= 0) {
        throw new AppError('La cantidad tiene que ser un entero mayor a cero', 400, 'CANTIDAD_INVALIDA');
      }

      const modo: ModoAjuste = item.modo ?? 'agregar';
      if (!['agregar', 'restar', 'establecer'].includes(modo)) {
        throw new AppError(`Modo de ajuste desconocido: ${String(item.modo)}`, 400, 'MODO_INVALIDO');
      }

      const candidatos = await resolverProducto(String(item.producto ?? item.codigo ?? ''), sucursal);

      if (candidatos.length === 0) {
        throw new AppError(`No se encontro el producto: ${item.producto}`, 404, 'PRODUCTO_NO_ENCONTRADO');
      }
      if (candidatos.length > 1) {
        throw new AppError(`Varios productos coinciden con: ${item.producto}`, 409, 'PRODUCTO_AMBIGUO');
      }

      const producto = candidatos[0];
      if (!producto) {
        throw new AppError(`No se encontro el producto: ${item.producto}`, 404, 'PRODUCTO_NO_ENCONTRADO');
      }
      if (producto.visibilidad === 'Sucursal' && sucursal === '') {
        throw new AppError('El producto pertenece a una sucursal', 400, 'SUCURSAL_REQUERIDA');
      }

      const stockAnterior = Number(producto.stock ?? 0);
      const stockResultante =
        modo === 'agregar' ? stockAnterior + cantidad
          : modo === 'restar' ? stockAnterior - cantidad
            : cantidad;

      if (stockResultante < 0) {
        throw new AppError(
          `Stock insuficiente para ${producto.nombre} (disponible: ${stockAnterior})`,
          422,
          'STOCK_NEGATIVO',
        );
      }

      /* agotado se recalcula aca: el hook pre('save') del modelo no corre en
         findOneAndUpdate, y el CRUD generico tampoco lo hace. Sin esto el POS
         seguiria ofreciendo un producto ya agotado. */
      const agotado = producto.controlado === true && stockResultante <= 0;

      const actualizado = await Product.findOneAndUpdate(
        { _id: producto._id },
        { $set: { stock: stockResultante, agotado, actualizadoEn: new Date() } },
        { new: true, ...opciones },
      ).exec();

      if (!actualizado) {
        throw new AppError(`No se pudo actualizar ${producto.nombre}`, 409, 'AJUSTE_CONFLICTO');
      }

      movimientos.push({
        productoId: String(actualizado._id),
        nombreProducto: actualizado.nombre,
        sucursal: sucursal !== '' ? sucursal : (producto.sucursal ?? 'Unificado'),
        tipo: modo === 'establecer' ? 'ajuste' : modo === 'agregar' ? 'ingreso' : 'egreso',
        motivo: String(item.motivo ?? 'Ajuste por integracion'),
        cantidad,
        cantidadAnterior: stockAnterior,
        cantidadResultante: stockResultante,
        usuario: String(solicitud.usuario ?? 'integracion'),
        origen: String(solicitud.origen ?? 'integracion'),
        fecha: new Date(),
        estado: 'aplicado',
      });

      aplicados.push({
        productoId: String(actualizado._id),
        codigo: actualizado.codigo ?? '',
        nombre: actualizado.nombre,
        modo,
        cantidad,
        stockAnterior,
        stockResultante,
        agotado,
        movimientoId: '',
      });
    }

    /* El primer movimiento ancla la clave de idempotencia; guarda el detalle
       completo para poder devolverlo tal cual ante un reintento.

       La sesion va como opcion de create(), nunca dentro del documento: el
       esquema es strict:false, asi que Mongoose intentaria persistirla y
       ClientSession tiene referencias circulares, que BSON no serializa. */
    const creados = await InventoryMovement.create(
      movimientos.map((m, indice) => ({
        ...m,
        ...(clave !== '' && indice === 0 ? { idempotencyKey: clave, detalle: aplicados } : {}),
      })),
      opciones,
    );

    creados.forEach((mov, indice: number) => {
      const aplicado = aplicados[indice];
      if (aplicado) aplicado.movimientoId = String(mov._id);
    });

    return aplicados;
  });

  await recordAudit({
    tipo: 'ajuste_stock',
    origen: String(solicitud.origen ?? 'integracion'),
    motivo: `Ajuste de ${resultados.length} producto(s) por ${String(solicitud.canal ?? 'api')}`,
    sucursal,
    adminNombre: String(solicitud.usuario ?? 'integracion'),
    detalle: { ip: contexto.ip, userAgent: contexto.userAgent },
  });

  return { replayed: false, resultados };
};