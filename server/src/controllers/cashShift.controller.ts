import type { NextFunction, Request, Response } from 'express';
import { cerrarTurno } from '../services/cashShift.service.js';
import { AppError, sendOk } from '../utils/response.js';

/**
 * Cierre de caja (Cierre Z).
 *
 * Body:
 *   {
 *     turnoId: string,
 *     declaracion: { efectivo, tarjeta, transferencia, gastos? },
 *     cajero: string,
 *     cajeroId?: string,
 *     observacion?: string,
 *     forzado?: boolean,
 *     motivoForzado?: string
 *   }
 *
 * Los totales esperados NO se reciben: los recalcula el servicio desde las
 * ordenes del turno.
 */
export const cerrar = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = req.body as {
      turnoId?: string;
      declaracion?: { efectivo?: number; tarjeta?: number; transferencia?: number; gastos?: number };
      cajero?: string;
      cajeroId?: string;
      observacion?: string;
      forzado?: boolean;
      motivoForzado?: string;
    };

    if (typeof body.turnoId !== 'string' || body.turnoId.trim() === '') {
      throw new AppError('Falta el turnoId', 400, 'MISSING_SHIFT_ID');
    }
    if (typeof body.cajero !== 'string' || body.cajero.trim() === '') {
      throw new AppError('Falta el nombre del cajero', 400, 'MISSING_CASHIER');
    }

    const d = body.declaracion ?? {};
    const numeros = [d.efectivo, d.tarjeta, d.transferencia];
    if (numeros.some((n) => n !== undefined && !Number.isFinite(Number(n)))) {
      throw new AppError('La declaracion tiene valores no numericos', 422, 'INVALID_DECLARATION');
    }

    const resultado = await cerrarTurno(
      {
        turnoId: body.turnoId.trim(),
        declaracion: {
          efectivo: Number(d.efectivo ?? 0),
          tarjeta: Number(d.tarjeta ?? 0),
          transferencia: Number(d.transferencia ?? 0),
          gastos: Number(d.gastos ?? 0),
        },
        cajero: body.cajero.trim(),
        cajeroId: body.cajeroId ?? null,
        observacion: body.observacion,
        forzado: body.forzado === true,
        motivoForzado: body.motivoForzado,
      },
      { ip: req.ip ?? '', userAgent: String(req.headers['user-agent'] ?? '') },
    );

    sendOk(res, resultado, 201);
  } catch (error) {
    next(error);
  }
};
