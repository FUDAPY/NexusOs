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

  /**
   * Un id con formato invalido (ej. GET /products/abc cuando el _id es un
   * ObjectId) hacia caer esta rama al 500 generico: el cliente recibia "Error
   * interno del servidor" por lo que en realidad es un dato mal formado.
   */
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
