import type { Request } from 'express';
import { redis } from '../config/redis.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/response.js';

export interface AuthenticatedRequest extends Request {
  auth?: { userId: string; rol: string; sucursalId: string | null };
}

/** Restringe endpoints internos por token de servicio (header x-service-token). */
export const requireServiceToken = (req: Request, _res: unknown, next: (error?: unknown) => void): void => {
  const token = req.header('x-service-token');
  if (!token || token !== env.JWT_SECRET) {
    next(new AppError('Token de servicio invalido', 401, 'UNAUTHORIZED'));
    return;
  }
  next();
};

/** Cachea respuestas GET en Redis para lecturas calientes del POS. */
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
