import type { NextFunction, Request, Response } from 'express';
import { pagarDeudaCliente } from '../services/pagoDeuda.service.js';
import { AppError, sendOk } from '../utils/response.js';

/**
 * POST /api/v1/orders/pagar-deuda  { clienteId, monto, metodoPago?, turnoId? }
 *
 * Registra el pago de la deuda de un cliente: la resta, crea el ticket del abono y
 * OTORGA los puntos por el monto pagado (1 por cada 1.000 Gs).
 *
 * Reemplaza al writeBatch del POS que restaba `users.deuda` y creaba el ticket a mano
 * sobre Firestore, que ya no autoriza: por eso el POS no podia cobrar una deuda.
 *
 * Cobra quien maneja plata: admin, supervisor o cajero.
 */
export const pagarDeuda = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = req.body as {
      clienteId?: unknown;
      monto?: unknown;
      metodoPago?: unknown;
      cajero?: unknown;
      sucursal?: unknown;
      turnoId?: unknown;
      nombreCliente?: unknown;
    };

    const clienteId = String(body.clienteId ?? '').trim();
    if (clienteId === '') {
      throw new AppError('Falta el cliente', 400, 'MISSING_CLIENTE');
    }

    sendOk(
      res,
      await pagarDeudaCliente(
        clienteId,
        {
          monto: Number(body.monto ?? 0),
          metodoPago: typeof body.metodoPago === 'string' ? body.metodoPago : undefined,
          cajero: typeof body.cajero === 'string' ? body.cajero : undefined,
          sucursal: typeof body.sucursal === 'string' ? body.sucursal : undefined,
          turnoId: typeof body.turnoId === 'string' ? body.turnoId : undefined,
          nombreCliente: typeof body.nombreCliente === 'string' ? body.nombreCliente : undefined,
        },
        { ip: req.ip ?? '', userAgent: String(req.headers['user-agent'] ?? '') },
      ),
    );
  } catch (error) {
    next(error);
  }
};
