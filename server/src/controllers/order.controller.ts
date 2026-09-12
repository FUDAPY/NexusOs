import type { NextFunction, Request, Response } from 'express';
import { ESTADOS_COCINA, Order } from '../models/index.js';
import { createOrderInputSchema, listOrdersQuerySchema } from '../schemas/order.schema.js';
import { createOrder } from '../services/order.service.js';
import { AppError, sendOk } from '../utils/response.js';

export const create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = createOrderInputSchema.safeParse(req.body);
    if (!parsed.success) {
      const detalle = parsed.error.issues.map((issue) => issue.message).join(' | ');
      throw new AppError(detalle, 422, 'VALIDATION_ERROR');
    }

    const result = await createOrder(parsed.data, {
      ip: req.ip ?? '',
      userAgent: req.header('user-agent') ?? '',
    });

    sendOk(res, result, 201);
  } catch (error) {
    next(error);
  }
};

export const list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = listOrdersQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError('Parametros de consulta invalidos', 422, 'VALIDATION_ERROR');
    }

    const { sucursal, turnoId, estadoPago, desde, hasta, page, limit } = parsed.data;
    const filter: Record<string, unknown> = {};

    if (sucursal) filter['sucursal'] = sucursal;
    if (turnoId) filter['turnoId'] = turnoId;
    if (estadoPago) filter['estadoPago'] = estadoPago;
    if (desde || hasta) {
      filter['fecha'] = {
        ...(desde ? { $gte: desde } : {}),
        ...(hasta ? { $lte: hasta } : {}),
      };
    }

    const [items, total] = await Promise.all([
      Order.find(filter)
        .sort({ fecha: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      Order.countDocuments(filter).exec(),
    ]);

    sendOk(res, { items, total, page, limit });
  } catch (error) {
    next(error);
  }
};

export const updateKdsState = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { id } = req.params;
    const { estadoCocina } = req.body as { estadoCocina?: string };

    if (!estadoCocina || !ESTADOS_COCINA.includes(estadoCocina as (typeof ESTADOS_COCINA)[number])) {
      throw new AppError('estadoCocina invalido', 422, 'VALIDATION_ERROR');
    }

    const order = await Order.findByIdAndUpdate(id, { estadoCocina }, { new: true }).exec();
    if (!order) throw new AppError('Orden no encontrada', 404, 'ORDER_NOT_FOUND');

    sendOk(res, order.toObject());
  } catch (error) {
    next(error);
  }
};
