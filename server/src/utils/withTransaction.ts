import mongoose, { type ClientSession } from 'mongoose';
import { supportsTransactions } from '../config/database.js';
import { AppError } from './response.js';

export type TransactionWork<TResult> = (session: ClientSession | null) => Promise<TResult>;


export const withTransaction = async <TResult>(work: TransactionWork<TResult>): Promise<TResult> => {
  if (!supportsTransactions()) {
    return work(null);
  }

  const session = await mongoose.startSession();
  try {
    let result: TResult | undefined;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    if (result === undefined) {
      throw new AppError('La transaccion finalizo sin resultado', 500, 'TRANSACTION_EMPTY');
    }
    return result;
  } finally {
    await session.endSession();
  }
};


export const withRedisLock = async <TResult>(
  key: string,
  ttlMs: number,
  work: () => Promise<TResult>,
): Promise<TResult> => {
  const { redis } = await import('../config/redis.js');
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const acquired = await redis.set(key, token, 'PX', ttlMs, 'NX');

  if (acquired !== 'OK') {
    throw new AppError('Recurso bloqueado por otra operacion en curso', 409, 'RESOURCE_LOCKED');
  }

  try {
    return await work();
  } finally {
    // Libera solo si el token sigue siendo el propietario (evita soltar lock ajeno expirado).
    await redis.eval(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
      1,
      key,
      token,
    );
  }
};
