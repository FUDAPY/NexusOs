import { Router } from 'express';
import { AuditLog } from '../models/index.js';
import { asyncHandler, sendOk } from '../utils/response.js';

export const auditRouter: Router = Router();

/** Feed de incidencias para el monitor interno (ex monitoreo de alertas Firebase). */
auditRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { tipo, modulo, severidad, sucursal } = req.query as Record<string, string | undefined>;
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 500);

    const filter: Record<string, unknown> = {};
    if (tipo) filter['tipo'] = tipo;
    if (modulo) filter['modulo'] = modulo;
    if (severidad) filter['severidad'] = severidad;
    if (sucursal) filter['sucursal'] = sucursal;

    const items = await AuditLog.find(filter).sort({ fecha: -1 }).limit(limit).lean().exec();
    sendOk(res, { items, total: items.length });
  }),
);
