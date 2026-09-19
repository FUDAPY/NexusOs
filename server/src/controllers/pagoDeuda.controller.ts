import type { NextFunction, Request, Response } from 'express';
import { pagarDeudaCliente, registrarAbonoPendiente } from '../services/pagoDeuda.service.js';
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

/**
 * POST /api/v1/orders/abono-pendiente  { clienteId, monto, metodoPago?, observacion? }
 *
 * Registra el cobro de la deuda SIN aplicarlo: la deuda del cliente no cambia hasta que un
 * administrador lo apruebe, y los puntos se otorgan en ese momento, no aca.
 *
 * Es el flujo del rol COBRADOR, que cobra en la calle y no cierra caja. Antes iba a Firestore
 * con un setDoc, que ya no autoriza: el cobro se perdia.
 *
 * El cobro NO entra al arqueo (`noAfectaCaja`) porque la plata todavia no esta confirmada.
 */
export const registrarAbono = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = req.body as {
      clienteId?: unknown;
      monto?: unknown;
      metodoPago?: unknown;
      registradoPor?: unknown;
      sucursal?: unknown;
      turnoId?: unknown;
      nombreCliente?: unknown;
      observacion?: unknown;
    };

    const clienteId = String(body.clienteId ?? '').trim();
    if (clienteId === '') {
      throw new AppError('Falta el cliente', 400, 'MISSING_CLIENTE');
    }

    sendOk(
      res,
      await registrarAbonoPendiente(
        clienteId,
        {
          monto: Number(body.monto ?? 0),
          metodoPago: typeof body.metodoPago === 'string' ? body.metodoPago : undefined,
          registradoPor: typeof body.registradoPor === 'string' ? body.registradoPor : undefined,
          sucursal: typeof body.sucursal === 'string' ? body.sucursal : undefined,
          turnoId: typeof body.turnoId === 'string' ? body.turnoId : undefined,
          nombreCliente: typeof body.nombreCliente === 'string' ? body.nombreCliente : undefined,
          observacion: typeof body.observacion === 'string' ? body.observacion : undefined,
        },
        { ip: req.ip ?? '', userAgent: String(req.headers['user-agent'] ?? '') },
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
};
