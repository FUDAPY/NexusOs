import type { NextFunction, Request, Response } from 'express';
import { ESTADOS_COCINA, Order } from '../models/index.js';
import { createOrderInputSchema, listOrdersQuerySchema } from '../schemas/order.schema.js';
import { createOrder } from '../services/order.service.js';
import { cancelOrder } from '../services/orderCierre.service.js';
import { AppError, sendOk } from '../utils/response.js';
import { marcarComoAbonado, resolverCobro } from '../services/cobro.service.js';

/**
 * POST /orders/:id/cobro  { accion: 'aprobar' | 'rechazar', autorizadoPor?, autorizadoPorNombre? }
 *
 * Reemplaza el `writeBatch` del dashboard que tocaba `users.deuda` y `sales` a
 * la vez: en Mongo eso es una transaccion y por eso vive en el servidor.
 */
export const resolverCobroHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const body = req.body as { accion?: unknown; autorizadoPor?: string; autorizadoPorNombre?: string };
    const accion = String(body.accion ?? '');

    if (accion !== 'aprobar' && accion !== 'rechazar') {
      throw new AppError("`accion` tiene que ser 'aprobar' o 'rechazar'", 422, 'ACCION_INVALIDA');
    }

    const resultado = await resolverCobro(
      {
        orderId: String(req.params.id),
        accion,
        autorizadoPor: body.autorizadoPor,
        autorizadoPorNombre: body.autorizadoPorNombre,
      },
      { ip: req.ip ?? '', userAgent: req.header('user-agent') ?? '' },
    );

    sendOk(res, resultado);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /orders/:id/abonar  { motivo, autorizadoPor?, autorizadoPorNombre? }
 * Excluye el ticket del flujo de caja sin anularlo (no devuelve stock).
 */
export const marcarAbonado = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const body = req.body as { motivo?: unknown; autorizadoPor?: string; autorizadoPorNombre?: string };

    if (typeof body.motivo !== 'string' || body.motivo.trim() === '') {
      throw new AppError('Falta el motivo', 400, 'MISSING_MOTIVO');
    }

    const resultado = await marcarComoAbonado(
      {
        orderId: String(req.params.id),
        motivo: body.motivo,
        autorizadoPor: body.autorizadoPor,
        autorizadoPorNombre: body.autorizadoPorNombre,
      },
      { ip: req.ip ?? '', userAgent: req.header('user-agent') ?? '' },
    );

    sendOk(res, resultado);
  } catch (error) {
    next(error);
  }
};

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

    const { sucursal, turnoId, estadoPago, desde, hasta, page, limit, offset } = parsed.data;
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

    /* Si viene `offset`, manda: es la paginacion del sistema (skip directo) y la que manda el
       lector paginado. Si no, se traduce la pagina de siempre, para no cambiar nada de lo que
       ya funcionaba. */
    const salto = offset !== undefined ? offset : (page - 1) * limit;

    const [items, total] = await Promise.all([
      Order.find(filter)
        .sort({ fecha: -1 })
        .skip(salto)
        .limit(limit)
        .lean()
        .exec(),
      Order.countDocuments(filter).exec(),
    ]);

    sendOk(res, { items, total, page, limit, offset: salto });
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


export const cancel = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { id } = req.params;
    if (typeof id !== 'string' || id === '') {
      throw new AppError('Falta el id de la orden', 400, 'MISSING_ORDER_ID');
    }

    const body = req.body as {
      motivo?: string;
      tipo?: 'total' | 'parcial';
      cantidades?: Record<string, number>;
      autorizadoPor?: string;
      autorizadoPorNombre?: string;
    };

    if (typeof body.motivo !== 'string' || body.motivo.trim() === '') {
      throw new AppError('El motivo de anulacion es obligatorio', 400, 'MISSING_REASON');
    }

    const tipo: 'total' | 'parcial' = body.tipo === 'parcial' ? 'parcial' : 'total';
    const cantidades = body.cantidades ?? {};
    if (tipo === 'parcial' && Object.keys(cantidades).length === 0) {
      throw new AppError('La anulacion parcial necesita cantidades', 400, 'MISSING_QUANTITIES');
    }

    const resultado = await cancelOrder(
      {
        orderId: id,
        motivo: body.motivo.trim(),
        tipo,
        cantidades,
        autorizadoPor: body.autorizadoPor,
        autorizadoPorNombre: body.autorizadoPorNombre,
      },
      { ip: req.ip ?? '', userAgent: String(req.headers['user-agent'] ?? '') },
    );

    sendOk(res, resultado);
  } catch (error) {
    next(error);
  }
};