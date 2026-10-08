import { Router } from 'express';
import { asyncHandler, sendOk } from '../utils/response.js';
import { aTexto } from '../utils/texto.js';
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
    const producto = aTexto(req.query['producto']).trim();
    const sucursal = aTexto(req.query['sucursal']).trim();

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
          producto: aTexto(item['producto']),
          codigo: item['codigo'] === undefined ? undefined : aTexto(item['codigo']),
          cantidad: Number(item['cantidad'] ?? 0),
          modo: (item['modo'] === undefined ? undefined : aTexto(item['modo'])) as ModoAjuste | undefined,
          motivo: item['motivo'] === undefined ? undefined : aTexto(item['motivo']),
        };
      }),
      sucursal: body['sucursal'] === undefined ? undefined : aTexto(body['sucursal']),
      origen: body['origen'] === undefined ? undefined : aTexto(body['origen']),
      usuario: body['usuario'] === undefined ? undefined : aTexto(body['usuario']),
      usuarioRol: body['usuarioRol'] === undefined ? undefined : aTexto(body['usuarioRol']),
      canal: body['canal'] === undefined ? undefined : aTexto(body['canal']),
      idempotencyKey: aTexto(req.header('Idempotency-Key')).trim() || undefined,
    };

    sendOk(res, await ajustarStock(solicitud, {
      ip: req.ip ?? '',
      userAgent: String(req.headers['user-agent'] ?? ''),
    }));
  }),
);