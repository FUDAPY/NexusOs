import { Redis } from 'ioredis';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

/**
 * En test no hay Redis, y no hace falta que lo haya.
 *
 * Ojo con esto: `lazyConnect: false` abre el socket AL IMPORTAR el modulo. Como
 * app.ts arrastra toda la cadena de servicios, cada archivo de test arrancaba un
 * cliente real contra 127.0.0.1:6379, fallaba y entraba en bucle de reconexion.
 * El resultado eran cientos de lineas de ECONNREFUSED tapando el veredicto de
 * vitest (y arriesgando ocultar un error de verdad entre el ruido).
 *
 * La app ya tolera un Redis caido: los guardias `redis.status !== 'ready'` lo
 * dan por no disponible y siguen. En test simplemente se ve igual, pero sin
 * socket: el status queda en 'wait', que no es 'ready', asi que los guardias
 * hacen lo correcto sin que ningun test dependa de Redis.
 */
const opcionesRedis =
  env.NODE_ENV === 'test'
    ? {
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: true,
        enableOfflineQueue: false,
        retryStrategy: (): null => null,
      }
    : {
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: false,
      };

export const redis = new Redis(env.REDIS_URL, opcionesRedis);

redis.on('error', (error: Error) => logger.error({ err: error }, 'Redis error'));
redis.on('ready', () => logger.info('Redis conectado'));

export const redisKey = {
  shiftActive: (branchId: string, cashierId: string): string => `shift:active:${branchId}:${cashierId}`,
  session: (userId: string, sessionId: string): string => `session:${userId}:${sessionId}`,
  stockLock: (productId: string): string => `lock:stock:${productId}`,
  exchangeRate: (currencyCode: string): string => `fx:rate:${currencyCode.toUpperCase()}`,
  kdsQueue: (branchId: string): string => `kds:queue:${branchId}`,
} as const;

export const closeRedis = async (): Promise<void> => {
  if (redis.status !== 'end') await redis.quit();
};
