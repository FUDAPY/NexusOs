import { Router } from 'express';
import {
  cancel,
  create,
  list,
  marcarAbonado,
  resolverCobroHandler,
  updateKdsState,
} from '../controllers/order.controller.js';
import { asyncHandler } from '../utils/response.js';
import { requiereAuth, requiereRol } from '../middlewares/auth.js';

export const orderRouter: Router = Router();

// Todo /orders exige sesion (ver el control de acceso en app.ts).
orderRouter.use(requiereAuth);

orderRouter.post('/', asyncHandler(create));
orderRouter.get('/', asyncHandler(list));
orderRouter.patch('/:id/cocina', asyncHandler(updateKdsState));

/**
 * Anula una orden devolviendo el stock.
 * Body: { motivo, tipo: 'total'|'parcial', cantidades?: { productoId: n } }
 */
orderRouter.post('/:id/anular', asyncHandler(cancel));

/**
 * Resuelve el cobro de un abono de deuda.
 * Body: { accion: 'aprobar'|'rechazar', autorizadoPor?, autorizadoPorNombre? }
 *
 * Mueve la deuda del cliente, asi que se limita a quien puede autorizar plata:
 * admin, supervisor o cajero.
 */
orderRouter.post(
  '/:id/cobro',
  requiereRol('admin', 'supervisor', 'cajero'),
  asyncHandler(resolverCobroHandler),
);

/**
 * Excluye un ticket del flujo de caja sin anularlo.
 * Body: { motivo, autorizadoPor?, autorizadoPorNombre? }
 */
orderRouter.post(
  '/:id/abonar',
  requiereRol('admin', 'supervisor', 'cajero'),
  asyncHandler(marcarAbonado),
);
