import type { NextFunction, Request, Response } from 'express';
import { pagarDeudaCliente, registrarAbonoPendiente } from '../services/pagoDeuda.service.js';
import { AppError, sendOk } from '../utils/response.js';


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

