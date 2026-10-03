import { Router } from 'express';
import { asyncHandler, sendOk } from '../utils/response.js';
import { requireServiceToken } from '../middlewares/auth.js';
import {
  ajustarStock,
  consultarStock,
  type AjusteSolicitado,
  type AjusteSolicitud,
  type ModoAjuste,
} from '../services/inventario.service.js';

export const integrationRouter: Router = Router();

/* Endpoints para sistemas externos (OrbitaOs). Se autentican con token de
   servicio, no con JWT de usuario: el bot no es un usuario del sistema. */
integrationRouter.use(requireServiceToken);

integrationRouter.get(
  '/inventory/stock',
  asyncHandler(async (req, res) => {
    const producto = String(req.query['producto'] ?? '').trim();
    const sucursal = String(req.query['sucursal'] ?? '').trim();

    sendOk(res, await consultarStock(producto, sucursal));
  }),
);

integrationRouter.post(
  '/inventory/adjustments',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const crudos = Array.isArray(body['ajustes']) ? body['ajustes'] : [];

    const solicitud: AjusteSolicitud = {
      ajustes: crudos.map((crudo): AjusteSolicitado => {
        const item = (crudo ?? {}) as Record<string, unknown>;
        return {
          producto: String(item['producto'] ?? ''),
          codigo: item['codigo'] === undefined ? undefined : String(item['codigo']),
          cantidad: Number(item['cantidad'] ?? 0),
          modo: (item['modo'] === undefined ? undefined : String(item['modo'])) as ModoAjuste | undefined,
          motivo: item['motivo'] === undefined ? undefined : String(item['motivo']),
        };
      }),
      sucursal: body['sucursal'] === undefined ? undefined : String(body['sucursal']),
      origen: body['origen'] === undefined ? undefined : String(body['origen']),
      usuario: body['usuario'] === undefined ? undefined : String(body['usuario']),
      usuarioRol: body['usuarioRol'] === undefined ? undefined : String(body['usuarioRol']),
      canal: body['canal'] === undefined ? undefined : String(body['canal']),
      idempotencyKey: String(req.header('Idempotency-Key') ?? '').trim() || undefined,
    };

    sendOk(res, await ajustarStock(solicitud, {
      ip: req.ip ?? '',
      userAgent: String(req.headers['user-agent'] ?? ''),
    }));
  }),
);