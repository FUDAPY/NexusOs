import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';
import { AppError, sendFail } from '../utils/response.js';

interface MongoServerError extends Error {
  code?: number;
  keyValue?: Record<string, unknown>;
}

export const notFound = (req: Request, res: Response): void => {
  sendFail(res, 404, `Ruta no encontrada: ${req.method} ${req.originalUrl}`, 'NOT_FOUND');
};

export const errorHandler = (
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  /* TODO error que se responde queda registrado, con el stack que trae pino.
     Antes, los 400 y los 422 salian sin log: el cliente veia "Valor invalido para el campo
     X" y en el servidor no quedaba rastro, asi que ubicar el origen era adivinar. Un error
     sin log es un error que se repite.
     Los datos que se agregan son los que hacen falta para ubicarlo: en un CastError, el campo
     y el valor; en un ValidationError, los campos que fallaron. */
  logger.error(
    {
      err: error,
      path: req.originalUrl,
      method: req.method,
      ...(error instanceof mongoose.Error.CastError
        ? { tipo: 'CastError', campo: error.path, valor: String(error.value) }
        : {}),
      ...(error instanceof mongoose.Error.ValidationError
        ? { tipo: 'ValidationError', campos: Object.keys(error.errors) }
        : {}),
      ...(error instanceof ZodError ? { tipo: 'ZodError', campos: error.issues.map((i) => i.path.join('.')) } : {}),
    },
    'Error respondido al cliente',
  );

  if (error instanceof AppError) {
    sendFail(res, error.statusCode, error.message, error.code);
    return;
  }

  if (error instanceof ZodError) {
    sendFail(res, 422, error.issues.map((issue) => issue.message).join(' | '), 'VALIDATION_ERROR');
    return;
  }

  if (error instanceof mongoose.Error.ValidationError) {
    const detalle = Object.values(error.errors)
      .map((item) => item.message)
      .join(' | ');
    sendFail(res, 422, detalle, 'MONGOOSE_VALIDATION');
    return;
  }

  
  if (error instanceof mongoose.Error.CastError) {
    sendFail(
      res,
      400,
      `Valor invalido para el campo "${error.path}": ${String(error.value)}`,
      'CAST_ERROR',
    );
    return;
  }

  const mongoError = error as MongoServerError;
  if (mongoError.code === 11000) {
    const campo = Object.keys(mongoError.keyValue ?? {}).join(', ');
    sendFail(res, 409, `Valor duplicado en: ${campo}`, 'DUPLICATE_KEY');
    return;
  }

  logger.error({ err: error, path: req.originalUrl, method: req.method }, 'Error no controlado');
  sendFail(res, 500, 'Error interno del servidor', 'INTERNAL_ERROR');
};
