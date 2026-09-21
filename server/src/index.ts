import { createServer } from 'node:http';
import { buildApp } from './app.js';
import { env } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { closeRedis } from './config/redis.js';
import { logger } from './utils/logger.js';
import { closeSockets, registerKdsNamespace } from './sockets/kds.js';

const bootstrap = async (): Promise<void> => {
  await connectDatabase();

  const app = buildApp();
  const server = createServer(app);
  registerKdsNamespace(server);

  server.listen(env.PORT, () => {
    logger.info({ port: env.PORT, prefix: env.API_PREFIX }, 'POS CATE API escuchando');
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Cerrando servicio');
    await closeSockets();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectDatabase();
    await closeRedis();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
};

bootstrap().catch((error: unknown) => {
  
  logger.fatal(
    {
      err: error,
      mongo: {
        usuario: env.MONGO_USER ?? null,
        host: env.MONGO_HOST,
        base: env.MONGO_DB_NAME,
        replicaSet: env.MONGO_REPLICA_SET.trim() === '' ? null : env.MONGO_REPLICA_SET,
        authSource: env.MONGO_AUTH_SOURCE,
      },
    },
    'Fallo el arranque del servicio',
  );
  process.exit(1);
});
