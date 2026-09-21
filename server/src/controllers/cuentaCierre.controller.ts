import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ESTADOS_COCINA } from '../models/index.js';
import { actualizarCuentaPendiente, cerrarCuentaPendiente } from '../services/cuentaCierre.service.js';
import { orderItemInputSchema } from '../schemas/order.schema.js';
import type { CreateOrderInput } from '../schemas/order.schema.js';
import { AppError, sendOk } from '../utils/response.js';


export const cerrarCuenta = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const id = req.params['id'];
    if (typeof id !== 'string' || id === '') {
      throw new AppError('Falta la orden', 400, 'MISSING_ORDER_ID');
    }

    const body = req.body as Record<string, unknown>;

    const metodoPago = typeof body['metodoPago'] === 'string' ? body['metodoPago'] : '';
    if (metodoPago.trim() === '') {
      throw new AppError('Falta el metodo de pago', 400, 'MISSING_METODO_PAGO');
    }

    
    const crudos = Array.isArray(body['items']) ? (body['items'] as unknown[]) : [];
    if (crudos.length === 0) {
      throw new AppError('La cuenta necesita al menos un item', 400, 'MISSING_ITEMS');
    }
    const itemsParsed = z.array(orderItemInputSchema).safeParse(crudos);
    if (!itemsParsed.success) {
      throw new AppError(
        itemsParsed.error.issues.map((issue) => issue.message).join(' | '),
        422,
        'VALIDATION_ERROR',
      );
    }
    const items = itemsParsed.data;

    const numero = (valor: unknown): number => {
      const n = Number(valor);
      return Number.isFinite(n) ? n : 0;
    };
    const objeto = (valor: unknown): Record<string, unknown> | undefined =>
      typeof valor === 'object' && valor !== null ? (valor as Record<string, unknown>) : undefined;
    
    const fechaValida = (valor: unknown): Date | undefined => {
      if (typeof valor !== 'string' && !(valor instanceof Date)) return undefined;
      const fecha = new Date(valor as string | Date);
      return Number.isNaN(fecha.getTime()) ? undefined : fecha;
    };

    sendOk(
      res,
      await cerrarCuentaPendiente(
        id,
        {
          metodoPago,
          items,
          cajero: typeof body['cajero'] === 'string' ? body['cajero'] : '',
          puntosOtorgados: numero(body['puntosOtorgados']),
          puntosCanjeados: numero(body['puntosCanjeados']),
          observacion: typeof body['observacion'] === 'string' ? body['observacion'] : undefined,
          creditoLibre: body['creditoLibre'] === true,
          clienteId: typeof body['clienteId'] === 'string' ? body['clienteId'] : undefined,
          detalleEfectivo: objeto(body['detalleEfectivo']),
          detallesPago: objeto(body['detallesPago']),
          turnoId: typeof body['turnoId'] === 'string' ? body['turnoId'] : undefined,
          fechaAperturaTurno: fechaValida(body['fechaAperturaTurno']),
          discountAmount: numero(body['discountAmount']),
        },
        { ip: req.ip ?? '', userAgent: String(req.headers['user-agent'] ?? '') },
      ),
    );
  } catch (error) {
    next(error);
  }
};


export const actualizarCuenta = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const id = req.params['id'];
    if (typeof id !== 'string' || id === '') {
      throw new AppError('Falta la orden', 400, 'MISSING_ORDER_ID');
    }

    const body = req.body as Record<string, unknown>;

    const crudos = Array.isArray(body['items']) ? (body['items'] as unknown[]) : [];
    if (crudos.length === 0) {
      throw new AppError('La cuenta necesita al menos un item', 400, 'MISSING_ITEMS');
    }
    const itemsParsed = z.array(orderItemInputSchema).safeParse(crudos);
    if (!itemsParsed.success) {
      throw new AppError(
        itemsParsed.error.issues.map((issue) => issue.message).join(' | '),
        422,
        'VALIDATION_ERROR',
      );
    }

    const numero = (valor: unknown): number => {
      const n = Number(valor);
      return Number.isFinite(n) ? n : 0;
    };

    const estadoCocinaCrudo = typeof body['estadoCocina'] === 'string' ? body['estadoCocina'] : '';
    const estadoCocina = (ESTADOS_COCINA as readonly string[]).includes(estadoCocinaCrudo)
      ? (estadoCocinaCrudo as CreateOrderInput['estadoCocina'])
      : undefined;

    sendOk(
      res,
      await actualizarCuentaPendiente(
        id,
        {
          items: itemsParsed.data,
          discountAmount: numero(body['discountAmount']),
          observacion: typeof body['observacion'] === 'string' ? body['observacion'] : undefined,
          estadoCocina,
          cajero: typeof body['cajero'] === 'string' ? body['cajero'] : '',
        },
        { ip: req.ip ?? '', userAgent: String(req.headers['user-agent'] ?? '') },
      ),
    );
  } catch (error) {
    next(error);
  }
};
