import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { redis } from '../config/redis.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/response.js';

export interface AuthenticatedRequest extends Request {
  auth?: { userId: string; rol: string; sucursalId: string | null; nombre: string };
}

/* Restringe endpoints internos por token de servicio (header x-service-token). */
export const requireServiceToken = (req: Request, _res: unknown, next: (error?: unknown) => void): void => {
  const token = req.header('x-service-token');
  if (!token || token !== env.JWT_SECRET) {
    next(new AppError('Token de servicio invalido', 401, 'UNAUTHORIZED'));
    return;
  }
  next();
};


export const cacheGet = async (key: string): Promise<string | null> => {
  if (redis.status !== 'ready') return null;
  return redis.get(key);
};

export const cacheSet = async (key: string, value: string, ttlSeconds: number): Promise<void> => {
  if (redis.status !== 'ready') return;
  await redis.set(key, value, 'EX', ttlSeconds);
};

export const invalidateCache = async (pattern: string): Promise<void> => {
  if (redis.status !== 'ready') return;
  const keys = await redis.keys(pattern);
  if (keys.length > 0) await redis.del(...keys);
};






export const requiereAuth = (req: Request, _res: Response, next: NextFunction): void => {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (token === '') {
    next(new AppError('Falta el token de acceso', 401, 'SIN_TOKEN'));
    return;
  }

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload;
    (req as AuthenticatedRequest).auth = {
      userId: String(payload.sub ?? ''),
      rol: String(payload['rol'] ?? ''),
      sucursalId: payload['sucursal'] === undefined ? null : String(payload['sucursal']),
      // El nombre sale del token, no del body: la auditoria tiene que registrar

      nombre: String(payload['nombre'] ?? ''),
    };
    next();
  } catch {
    next(new AppError('Token invalido o vencido', 401, 'TOKEN_INVALIDO'));
  }
};


export const requiereRol =
  (...roles: string[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const auth = (req as AuthenticatedRequest).auth;
    if (auth === undefined) {
      next(new AppError('No autenticado', 401, 'SIN_USUARIO'));
      return;
    }
    if (!roles.includes(auth.rol)) {
      next(new AppError(`El rol ${auth.rol} no tiene permiso para esta accion`, 403, 'SIN_PERMISO'));
      return;
    }
    next();
  };
