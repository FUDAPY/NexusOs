import { Router } from 'express';
import type { FilterQuery } from 'mongoose';
import { AuditLog, type IAuditLog } from '../models/index.js';
import { asyncHandler, sendOk } from '../utils/response.js';

export const auditRouter: Router = Router();

const LIMITE_POR_DEFECTO = 200;
const LIMITE_MAXIMO = 500;

/**
 * String o nada.
 *
 * Por que no alcanza con `!== undefined`: Express usa el parser `qs` (extended), asi que
 * `?tipo[$ne]=admin` NO llega como texto: llega como el OBJETO `{ $ne: 'admin' }`. Si ese objeto
 * se asignara al filtro, Mongo lo interpretaria como OPERADOR y el filtro se anularia (o peor,
 * devolveria lo que el operador dicte). Filtrando por tipo, el objeto no sobrevive y el campo
 * simplemente no se filtra.
 *
 * Esto era responsabilidad del `sanitizeFilter` global de Mongoose, que se apago por romper los
 * filtros propios (ver config/database.ts): la defensa correcta vive aca, en el borde.
 */
const soloTexto = (valor: unknown): string | undefined =>
  typeof valor === 'string' && valor !== '' ? valor : undefined;

/**
 * Arma el filtro del feed a partir de los query params.
 *
 * Esta exportado para poder probarlo sin base: es la unica ruta que lee `req.query` a mano, y
 * su defensa contra inyeccion de operadores tiene que quedar cubierta por un test.
 */
export const construirFiltroAuditoria = (q: Record<string, unknown>): FilterQuery<IAuditLog> => {
  const filtro: FilterQuery<IAuditLog> = {};

  const tipo = soloTexto(q['tipo']);
  const sucursal = soloTexto(q['sucursal']);
  const origen = soloTexto(q['origen']);
  const estado = soloTexto(q['estado']);

  if (tipo !== undefined) filtro.tipo = tipo;
  if (sucursal !== undefined) filtro.sucursal = sucursal;
  if (origen !== undefined) filtro.origen = origen;
  if (estado !== undefined) filtro.estado = estado;

  // `nivel` es el campo real; `severidad` se acepta como alias historico.
  const nivel = soloTexto(q['nivel']) ?? soloTexto(q['severidad']);
  if (nivel !== undefined) filtro.nivel = nivel;

  const rango: Record<string, Date> = {};
  const desde = soloTexto(q['desde']);
  const hasta = soloTexto(q['hasta']);
  if (desde !== undefined) {
    const d = new Date(desde);
    if (!Number.isNaN(d.getTime())) rango['$gte'] = d;
  }
  if (hasta !== undefined) {
    const h = new Date(hasta);
    if (!Number.isNaN(h.getTime())) rango['$lte'] = h;
  }
  if (Object.keys(rango).length > 0) filtro.fecha = rango;

  return filtro;
};

/**
 * Feed de incidencias para el monitor interno (ex monitoreo de alertas Firebase).
 *
 * Corrige dos defectos que tenia la version anterior:
 *
 * 1. Filtraba por `modulo` y `severidad`, campos que NO existen en `audit_logs`
 *    (el de severidad se llama `nivel`). Mongo no falla ante un campo
 *    inexistente: simplemente no matchea, asi que esos filtros devolvian
 *    siempre una lista vacia sin ningun error visible. Se acepta `severidad`
 *    como alias para no romper a quien ya lo mandaba.
 *
 * 2. Devolvia `total: items.length`, o sea el tamaño de la pagina. Al pedir
 *    limit=200 el cliente veia "200 resultados" aunque hubiera 40 000. Ahora
 *    `total` es el conteo real, que es lo que necesita cualquier paginador.
 */
auditRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = req.query as Record<string, unknown>;

    const limite = Math.min(Number(q['limit'] ?? LIMITE_POR_DEFECTO) || LIMITE_POR_DEFECTO, LIMITE_MAXIMO);
    const offset = Math.max(Number(q['offset'] ?? 0) || 0, 0);

    // Solo texto: un `?tipo[$ne]=x` llega como OBJETO por el parser `qs` y no debe entrar al
    // filtro como operador de Mongo. El detalle y su test, en `construirFiltroAuditoria`.
    const filtro = construirFiltroAuditoria(q);

    const [items, total] = await Promise.all([
      AuditLog.find(filtro).sort({ fecha: -1 }).skip(offset).limit(limite).lean().exec(),
      AuditLog.countDocuments(filtro).exec(),
    ]);

    sendOk(res, { items, total, limit: limite, offset });
  }),
);
