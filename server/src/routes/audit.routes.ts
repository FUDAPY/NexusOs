import { Router } from 'express';
import type { FilterQuery } from 'mongoose';
import { AuditLog, type IAuditLog } from '../models/index.js';
import { asyncHandler, sendOk } from '../utils/response.js';

export const auditRouter: Router = Router();

const LIMITE_POR_DEFECTO = 200;
const LIMITE_MAXIMO = 500;

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
    const q = req.query as Record<string, string | undefined>;

    const limite = Math.min(Number(q['limit'] ?? LIMITE_POR_DEFECTO) || LIMITE_POR_DEFECTO, LIMITE_MAXIMO);
    const offset = Math.max(Number(q['offset'] ?? 0) || 0, 0);

    const filtro: FilterQuery<IAuditLog> = {};

    if (q['tipo'] !== undefined && q['tipo'] !== '') filtro.tipo = q['tipo'];
    if (q['sucursal'] !== undefined && q['sucursal'] !== '') filtro.sucursal = q['sucursal'];
    if (q['origen'] !== undefined && q['origen'] !== '') filtro.origen = q['origen'];
    if (q['estado'] !== undefined && q['estado'] !== '') filtro.estado = q['estado'];

    // `nivel` es el campo real; `severidad` se acepta como alias historico.
    const nivel = q['nivel'] ?? q['severidad'];
    if (nivel !== undefined && nivel !== '') filtro.nivel = nivel;

    const rango: Record<string, Date> = {};
    if (q['desde'] !== undefined && q['desde'] !== '') {
      const d = new Date(q['desde']);
      if (!Number.isNaN(d.getTime())) rango['$gte'] = d;
    }
    if (q['hasta'] !== undefined && q['hasta'] !== '') {
      const h = new Date(q['hasta']);
      if (!Number.isNaN(h.getTime())) rango['$lte'] = h;
    }
    if (Object.keys(rango).length > 0) filtro.fecha = rango;

    const [items, total] = await Promise.all([
      AuditLog.find(filtro).sort({ fecha: -1 }).skip(offset).limit(limite).lean().exec(),
      AuditLog.countDocuments(filtro).exec(),
    ]);

    sendOk(res, { items, total, limit: limite, offset });
  }),
);
