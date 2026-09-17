import type { NextFunction, Request, Response } from 'express';
import { cerrarTurno } from '../services/cashShift.service.js';
import { abrirTurno } from '../services/cashApertura.service.js';
import { forzarCierreSucursal } from '../services/cashForzado.service.js';
import type { AuthenticatedRequest } from '../middlewares/auth.js';
import { AppError, sendOk } from '../utils/response.js';

/**
 * Cierre forzado de una sucursal entera desde el panel administrativo.
 *
 * Body:
 *   {
 *     sucursal: string,
 *     motivo: string,
 *     declaracion: { fondoInicial, efectivo, tarjeta, transferencia, gastos },
 *     htmlTicket?: string,   // ticket ya renderizado por el panel
 *     dryRun?: boolean       // calcular y devolver sin escribir nada
 *   }
 *
 * Los totales del SISTEMA no se reciben: los recalcula el servicio desde las
 * ordenes del turno activo. Solo llega lo que el admin conto a mano.
 */
export const forzarCierre = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = req.body as {
      sucursal?: unknown;
      motivo?: unknown;
      htmlTicket?: unknown;
      dryRun?: unknown;
      declaracion?: Record<string, unknown>;
    };

    if (typeof body.sucursal !== 'string' || body.sucursal.trim() === '') {
      throw new AppError('Falta la sucursal', 400, 'MISSING_SUCURSAL');
    }
    if (typeof body.motivo !== 'string' || body.motivo.trim() === '') {
      throw new AppError('Falta el motivo del cierre forzado', 400, 'MISSING_MOTIVO');
    }

    const d = body.declaracion ?? {};
    const aNumero = (valor: unknown): number => {
      const n = Number(valor);
      return Number.isFinite(n) ? n : 0;
    };

    const auth = (req as AuthenticatedRequest).auth;

    const resultado = await forzarCierreSucursal(
      {
        sucursal: body.sucursal,
        motivo: body.motivo,
        htmlTicket: typeof body.htmlTicket === 'string' ? body.htmlTicket : undefined,
        dryRun: body.dryRun === true,
        forzadoPor: auth?.userId,
        forzadoPorNombre: auth?.nombre,
        declaracion: {
          fondoInicial: aNumero(d['fondoInicial']),
          efectivo: aNumero(d['efectivo']),
          tarjeta: aNumero(d['tarjeta']),
          transferencia: aNumero(d['transferencia']),
          gastos: aNumero(d['gastos']),
        },
      },
      { ip: req.ip ?? '', userAgent: req.header('user-agent') ?? '' },
    );

    sendOk(res, resultado);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/cash-shifts/abrir
 *
 * Apertura del turno de caja. Body:
 *   {
 *     sucursal: string,
 *     fondoInicial: number,
 *     cajero?: string,          // nombre; si falta se usa el del token
 *     cajeroId?: string,
 *     turnoId?: string,         // el POS lo genera; si falta se arma uno
 *     sucursalesActivas?: string[]
 *   }
 *
 * IDEMPOTENTE: si la sucursal ya tiene un turno abierto, devuelve ESE con
 * `creado: false` en vez de abrir otro. Es lo que impide que se repita el bug
 * de los 13 turnos abiertos.
 *
 * Devuelve `fechaAperturaMs` porque el POS lo consumia asi de la Cloud Function
 * vieja.
 */
export const abrir = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = req.body as {
      sucursal?: unknown;
      cajero?: unknown;
      cajeroId?: unknown;
      turnoId?: unknown;
      fondoInicial?: unknown;
      sucursalesActivas?: unknown;
    };

    if (typeof body.sucursal !== 'string' || body.sucursal.trim() === '') {
      throw new AppError('Falta la sucursal', 400, 'MISSING_SUCURSAL');
    }

    // El nombre y el id salen del token siempre que se pueda: es la sesion que
    // el servidor verifico. El body queda solo como respaldo.
    const auth = (req as AuthenticatedRequest).auth;

    sendOk(
      res,
      await abrirTurno(
        {
          sucursal: body.sucursal,
          turnoId: typeof body.turnoId === 'string' ? body.turnoId : undefined,
          cajero: auth?.nombre !== undefined && auth.nombre !== ''
            ? auth.nombre
            : (typeof body.cajero === 'string' ? body.cajero : undefined),
          cajeroId: typeof body.cajeroId === 'string' && body.cajeroId !== ''
            ? body.cajeroId
            : (auth?.userId ?? null),
          fondoInicial: Number(body.fondoInicial ?? 0),
          sucursalesActivas: Array.isArray(body.sucursalesActivas)
            ? (body.sucursalesActivas as unknown[]).filter((s): s is string => typeof s === 'string')
            : undefined,
        },
        { ip: req.ip ?? '', userAgent: String(req.headers['user-agent'] ?? '') },
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
};

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
 *     motivoForzado?: string,
 *     htmlTicket?: string   // ticket Z ya renderizado; solo se guarda
 *   }
 *
 * Los totales esperados NO se reciben: los recalcula el servicio desde las
 * ordenes del turno. `gastos` si se recibe porque es plata que el cajero pago
 * del cajon: el servicio la resta del efectivo esperado.
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
      htmlTicket?: string;
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
        htmlTicket: typeof body.htmlTicket === 'string' ? body.htmlTicket : undefined,
      },
      { ip: req.ip ?? '', userAgent: String(req.headers['user-agent'] ?? '') },
    );

    sendOk(res, resultado, 201);
  } catch (error) {
    next(error);
  }
};
