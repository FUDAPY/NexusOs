import { Router } from 'express';
import type { FilterQuery } from 'mongoose';
import { AuditLog, type IAuditLog } from '../models/index.js';
import { asyncHandler, sendOk } from '../utils/response.js';

export const auditRouter: Router = Router();

const LIMITE_POR_DEFECTO = 200;
const LIMITE_MAXIMO = 500;


const soloTexto = (valor: unknown): string | undefined =>
  typeof valor === 'string' && valor !== '' ? valor : undefined;


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


auditRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = req.query as Record<string, unknown>;

    const limite = Math.min(Number(q['limit'] ?? LIMITE_POR_DEFECTO) || LIMITE_POR_DEFECTO, LIMITE_MAXIMO);
    const offset = Math.max(Number(q['offset'] ?? 0) || 0, 0);


    // filtro como operador de Mongo. El detalle y su test, en `construirFiltroAuditoria`.
    const filtro = construirFiltroAuditoria(q);

    const [items, total] = await Promise.all([
      AuditLog.find(filtro).sort({ fecha: -1 }).skip(offset).limit(limite).lean().exec(),
      AuditLog.countDocuments(filtro).exec(),
    ]);

    sendOk(res, { items, total, limit: limite, offset });
  }),
);
