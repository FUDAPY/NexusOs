import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { orderRouter } from './routes/order.routes.js';
import { errorHandler, notFound } from './middlewares/errorHandler.js';
import { auditRouter } from './routes/audit.routes.js';
import { resourceRouter, publicResourceRouter } from './routes/resource.routes.js';
import { cashShiftRouter } from './routes/cashShift.routes.js';
import { productionRouter } from './routes/production.routes.js';
import { authRouter } from './routes/auth.routes.js';
import { configRouter } from './routes/config.routes.js';
import { uploadRouter } from './routes/upload.routes.js';
import { requiereAuth } from './middlewares/auth.js';

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
  /* Subidas de imagenes: van ANTES del parser global y con su propio limite, mas grande.
     El global corta en 1mb y una foto de producto no entra; body-parser se salta lo que ya se
     parseo, asi que montar este antes no rompe nada. El POST exige token y el GET es publico
     (las pantallas muestran la imagen con <img src>, que no manda token). */
  app.use(`${env.API_PREFIX}/uploads`, express.json({ limit: '6mb' }), uploadRouter);
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger }));

  app.get('/health', (_req, res) => {
    res.json({ success: true, data: { status: 'ok', uptime: process.uptime() } });
  });

  /* ------------------------------------------------------------------ */
  /* Control de acceso                                                    */
  /* ------------------------------------------------------------------ */
  /* Las firestore.rules hacian de barrera: sin ellas nadie podia leer ni
     escribir. Al mover los datos a Mongo esa barrera DESAPARECE, y este
     servidor quedaba sin ninguna: cualquiera que alcanzara el dominio podia
     leer todo y, peor, hacer POST /users con rol 'admin' y escalar privilegios.
     Por eso todo lo de abajo pasa por requiereAuth. */

  // Publico y sin token: solo lectura, para metas-publicas.html.
  // Va primero; si la peticion no matchea (POST/PATCH) Express sigue al
  // router protegido de mas abajo.
  app.use(env.API_PREFIX, publicResourceRouter);

  // Login y alta de sesion tienen que quedar fuera, obviamente.
  app.use(`${env.API_PREFIX}/auth`, authRouter);

  app.use(`${env.API_PREFIX}/orders`, requiereAuth, orderRouter);
  app.use(`${env.API_PREFIX}/audit-logs`, requiereAuth, auditRouter);
  // Va ANTES que resourceRouter: necesita resolver POST /cash-shifts/cerrar
  // antes de que el CRUD generico tome el prefijo.
  app.use(`${env.API_PREFIX}/cash-shifts`, requiereAuth, cashShiftRouter);

// Va ANTES que resourceRouter: necesita resolver POST /production-batches/lote, que
// crea el lote y acredita los contadores de la sucursal en una transaccion.
app.use(`${env.API_PREFIX}/production-batches`, requiereAuth, productionRouter);

  // Configuracion global: /settings sigue siendo solo lectura en el CRUD
  // generico; las escrituras pasan por aca con control de rol.
  app.use(`${env.API_PREFIX}/config`, configRouter);

  // El resto del CRUD generico (~23 colecciones) exige token.
  app.use(env.API_PREFIX, requiereAuth, resourceRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
};
