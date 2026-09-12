import { Router } from 'express';
import { create, list, updateKdsState } from '../controllers/order.controller.js';
import { asyncHandler } from '../utils/response.js';

export const orderRouter: Router = Router();

orderRouter.post('/', asyncHandler(create));
orderRouter.get('/', asyncHandler(list));
orderRouter.patch('/:id/cocina', asyncHandler(updateKdsState));
