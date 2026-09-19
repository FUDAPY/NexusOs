import { Router } from 'express';
import { registrarLote } from '../services/production.service.js';
import { asyncHandler, sendOk } from '../utils/response.js';
import { requiereAuth, requiereRol } from '../middlewares/auth.js';

/**
 * Escrituras propias de produccion.
 *
 * Se monta ANTES que resourceRouter sobre el mismo prefijo, igual que cashShiftRouter:
 *   POST /production-batches/lote  -> aca (crea el lote Y acredita los contadores)
 *   GET  /production-batches       -> resourceRouter (CRUD generico)
 *
 * Express prueba los routers en orden, asi que /lote se resuelve aca y el resto cae al
 * CRUD sin conflicto.
 */
export const productionRouter: Router = Router();

productionRouter.use(requiereAuth);

/**
 * POST /api/v1/production-batches/lote
 * Body: { sucursalKey, sucursal?, tipoInsumo, cantidad, unidad?, observacion? }
 *
 * Registra un lote de produccion y acredita la cantidad en los contadores de la
 * sucursal, en una transaccion. Ver production.service.ts para el porque.
 *
 * Carga quien maneja el insumo: admin, supervisor o cocina. Un cajero no carga
 * produccion, pero si puede consultarla.
 */
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
