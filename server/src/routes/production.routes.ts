import { Router } from 'express';
import { registrarLote } from '../services/production.service.js';
import { asyncHandler, sendOk } from '../utils/response.js';
import { requiereAuth, requiereRol } from '../middlewares/auth.js';


export const productionRouter: Router = Router();

productionRouter.use(requiereAuth);


productionRouter.post(
  '/lote',
  requiereRol('admin', 'supervisor', 'cocina'),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const auth = (req as unknown as { auth?: { nombre?: string; userId?: string } }).auth;

    sendOk(
      res,
      await registrarLote(
        {
          sucursalKey: String(body['sucursalKey'] ?? ''),
          sucursal: typeof body['sucursal'] === 'string' ? body['sucursal'] : '',
          tipoInsumo: String(body['tipoInsumo'] ?? ''),
          cantidad: Number(body['cantidad'] ?? 0),
          unidad: typeof body['unidad'] === 'string' ? body['unidad'] : 'unidades',
          observacion: typeof body['observacion'] === 'string' ? body['observacion'] : '',
          creadoPor: auth?.userId ?? '',
          creadoPorNombre: auth?.nombre ?? '',
        },
        { ip: req.ip ?? '', userAgent: String(req.headers['user-agent'] ?? '') },
      ),
      201,
    );
  }),
);
