import mongoose, { type ClientSession } from 'mongoose';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

// Habilitado tras detectar replica set o mongos; las transacciones ACID lo requieren.
let transactionsSupported = false;

export const supportsTransactions = (): boolean => transactionsSupported;

/**
 * `code 18` = AuthenticationFailed. Es determinista: la credencial no coincide,
 * y por mas que se reintente va a seguir sin coincidir. Se corta al instante en
 * vez de insistir (lo que ademas llenaria el log de ruido y taparia la causa).
 */
const esFalloDeCredenciales = (error: unknown): boolean => {
  const e = error as { code?: number; codeName?: string } | null;
  return e?.code === 18 || e?.codeName === 'AuthenticationFailed';
};

/**
 * Intentos de conexion al arrancar.
 *
 * `depends_on` de Compose garantiza que el contenedor de mongo EXISTA, no que
 * este LISTO para aceptar conexiones. Mongod con --keyFile y --replSet tarda
 * decenas de segundos en levantarse y elegirse primary, asi que el primer
 * intento del api puede fallar aunque no haya nada roto. Sin reintentos, eso
 * significaba morir y depender del restart del contenedor para volver a probar.
 *
 * El presupuesto es corto a proposito: si Mongo no aparece en ~1 minuto, algo
 * esta mal de verdad y conviene que el contenedor falle para que se vea.
 */
const INTENTOS_CONEXION = 6;
const ESPERA_ENTRE_INTENTOS_MS = 5_000;

export const connectDatabase = async (): Promise<void> => {
  mongoose.set('strictQuery', true);
  mongoose.set('sanitizeFilter', true);

  for (let intento = 1; ; intento += 1) {
    try {
      await mongoose.connect(env.MONGO_URI, {
        maxPoolSize: env.MONGO_MAX_POOL_SIZE,
        serverSelectionTimeoutMS: 10_000,
        autoIndex: env.NODE_ENV !== 'production',
      });
      break;
    } catch (error) {
      if (esFalloDeCredenciales(error)) {
        logger.error(
          {
            usuario: env.MONGO_USER ?? null,
            base: env.MONGO_DB_NAME,
            authSource: env.MONGO_AUTH_SOURCE,
          },
          'Mongo rechazo la credencial. Revisar que MONGO_INITDB_ROOT_PASSWORD coincida con ' +
            'la que tiene el usuario DENTRO del volumen: esa variable SOLO se aplica cuando ' +
            'el volumen esta vacio, asi que cambiarla despues no toca la clave guardada. ' +
            'Para alinearlas: db.getSiblingDB("admin").changeUserPassword(...)',
        );
        throw error;
      }

      if (intento >= INTENTOS_CONEXION) {
        logger.error(
          { intento, de: INTENTOS_CONEXION },
          'Mongo no respondio tras agotar los reintentos',
        );
        throw error;
      }

      logger.warn(
        { intento, de: INTENTOS_CONEXION, esperaMs: ESPERA_ENTRE_INTENTOS_MS },
        'Mongo todavia no responde; reintentando',
      );
      await new Promise((resolve) => setTimeout(resolve, ESPERA_ENTRE_INTENTOS_MS));
    }
  }

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
