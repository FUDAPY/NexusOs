import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { cerrarCuentaPendiente } from '../services/cuentaCierre.service.js';
import { orderItemInputSchema } from '../schemas/order.schema.js';
import { AppError, sendOk } from '../utils/response.js';

/**
 * POST /api/v1/orders/:id/cerrar-cuenta
 *
 * Cobra una cuenta pendiente (la mesa abierta). Body:
 *   {
 *     metodoPago: string,
 *     items: [{ id, cantidad, controlado }],
 *     cajero?, clienteId?, creditoLibre?, observacion?,
 *     puntosOtorgados?, puntosCanjeados?,
 *     detalleEfectivo?, detallesPago?
 *   }
 *
 * Pasa la orden a pagada en vez de crear otra: sin esto, cobrar una mesa
 * duplicaba la venta.
 *
 * Los items se mandan para VALIDAR que no cambiaron. Si cambiaron, responde 409
 * CUENTA_CON_CAMBIOS: cerrar con el carrito distinto moveria la plata sin mover
 * el stock.
 */
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

    /* Mismo contrato de items que POST /orders: el servicio recalcula el total con
       ellos, asi que tienen que traer precio y descuentos, no solo id y cantidad.
       Se valida aca para poder responder con el motivo concreto. */
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
    /** Fecha valida o undefined: una fecha rota no debe romper el cobro. */
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
