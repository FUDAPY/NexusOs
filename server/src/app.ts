import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { orderRouter } from './routes/order.routes.js';
import { errorHandler, notFound } from './middlewares/errorHandler.js';
import { auditRouter } from './routes/audit.routes.js';
import { resourceRouter } from './routes/resource.routes.js';

export const buildApp = (): Express => {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : true,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger }));

  app.get('/health', (_req, res) => {
    res.json({ success: true, data: { status: 'ok', uptime: process.uptime() } });
  });

  app.use(`${env.API_PREFIX}/orders`, orderRouter);
  app.use(`${env.API_PREFIX}/audit-logs`, auditRouter);
  app.use(env.API_PREFIX, resourceRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
};
