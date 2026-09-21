import type { NextFunction, Request, Response } from 'express';
import { establecerPinCredito, validarPinCredito } from '../services/creditPin.service.js';
import { AppError, sendOk } from '../utils/response.js';

const contextoDe = (req: Request): { ip: string; userAgent: string } => ({
  ip: req.ip ?? '',
  userAgent: String(req.headers['user-agent'] ?? ''),
});


export const crearPin = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params['id'];
    if (typeof id !== 'string' || id === '') {
      throw new AppError('Falta el cliente', 400, 'MISSING_CLIENTE');
    }

    const body = req.body as { pin?: unknown };
    sendOk(res, await establecerPinCredito(id, String(body.pin ?? ''), contextoDe(req)));
  } catch (error) {
    next(error);
  }
};


export const validarPin = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = req.body as { clienteId?: unknown; pin?: unknown };
    const clienteId = String(body.clienteId ?? '');
    if (clienteId === '') {
      throw new AppError('Falta el cliente', 400, 'MISSING_CLIENTE');
    }

    const resultado = await validarPinCredito(clienteId, String(body.pin ?? ''), contextoDe(req));

    if (resultado.valido) {
      sendOk(res, resultado);
      return;
    }

    if (resultado.motivo === 'SIN_PIN') {
      throw new AppError('Este cliente no tiene PIN de credito configurado.', 403, 'SIN_PIN');
    }
    if (resultado.motivo === 'BLOQUEADO') {
      throw new AppError(
        'PIN bloqueado por demasiados intentos. Proba en unos minutos.',
        403,
        'PIN_BLOQUEADO',
      );
    }

    const restantes = Number(resultado.intentosRestantes ?? 0);
    throw new AppError(
      restantes > 0 ? `PIN incorrecto. Te quedan ${restantes} intentos.` : 'PIN incorrecto.',
      403,
      'PIN_INCORRECTO',
    );
  } catch (error) {
    next(error);
  }
};
