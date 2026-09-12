import { Redis } from 'ioredis';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
});

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
