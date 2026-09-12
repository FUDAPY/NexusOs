import mongoose, { type ClientSession } from 'mongoose';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

// Habilitado tras detectar replica set o mongos; las transacciones ACID lo requieren.
let transactionsSupported = false;

export const supportsTransactions = (): boolean => transactionsSupported;

export const connectDatabase = async (): Promise<void> => {
  mongoose.set('strictQuery', true);
  mongoose.set('sanitizeFilter', true);

  await mongoose.connect(env.MONGO_URI, {
    maxPoolSize: env.MONGO_MAX_POOL_SIZE,
    serverSelectionTimeoutMS: 10_000,
    autoIndex: env.NODE_ENV !== 'production',
  });

  const admin = mongoose.connection.db?.admin();
  if (admin) {
    try {
      const hello = (await admin.command({ hello: 1 })) as { setName?: string; msg?: string };
      transactionsSupported = Boolean(hello.setName) || hello.msg === 'isdbgrid';
    } catch (error) {
      transactionsSupported = false;
      logger.warn({ err: error }, 'No se pudo detectar replica set; transacciones deshabilitadas');
    }
  }

  logger.info(
    { host: mongoose.connection.host, db: mongoose.connection.name, transactionsSupported },
    'MongoDB conectado',
  );
};

export const disconnectDatabase = async (): Promise<void> => {
  await mongoose.connection.close();
};

export const startSession = (): Promise<ClientSession> => mongoose.startSession();
