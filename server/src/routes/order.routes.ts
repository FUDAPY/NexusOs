import { Router } from 'express';
import { cancel, create, list, updateKdsState } from '../controllers/order.controller.js';
import { asyncHandler } from '../utils/response.js';

export const orderRouter: Router = Router();

orderRouter.post('/', asyncHandler(create));
orderRouter.get('/', asyncHandler(list));
orderRouter.patch('/:id/cocina', asyncHandler(updateKdsState));

/**
 * Anula una orden devolviendo el stock.
 * Body: { motivo, tipo: 'total'|'parcial', cantidades?: { productoId: n } }
 */
orderRouter.post('/:id/anular', asyncHandler(cancel));
