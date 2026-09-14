/**
 * Copia todas las colecciones de un MongoDB origen a otro destino.
 *
 * Uso:
 *   MONGO_SOURCE_URI="mongodb://..." npm run mongo:copy
 *   npm run mongo:copy -- --dry-run      (solo cuenta, no escribe)
 *
 * El destino es siempre el MONGO_URI del .env.
 * Es idempotente: hace upsert por _id, asi que se puede reanudar sin duplicar.
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { logger } from '../src/utils/logger.js';

type BulkOperation = mongoose.mongo.AnyBulkWriteOperation;

const SOURCE_URI = process.env['MONGO_SOURCE_URI'];
const TARGET_URI = env.MONGO_URI;
const BATCH_SIZE = 500;
const DRY_RUN = process.argv.includes('--dry-run');

const openConnection = async (uri: string, label: string): Promise<mongoose.Connection> => {
  const connection = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 20_000 });
  await connection.asPromise();
  logger.info({ label, db: connection.name }, 'conexion establecida');
  return connection;
};

const main = async (): Promise<void> => {
  if (!SOURCE_URI) {
    throw new Error(
      'Falta MONGO_SOURCE_URI. Ejemplo: MONGO_SOURCE_URI="mongodb://giuli:clave@host:7752/pos_cate?authSource=admin" npm run mongo:copy',
    );
  }
  if (SOURCE_URI === TARGET_URI) {
    throw new Error('Origen y destino son la misma URI: abortado');
  }

  const source = await openConnection(SOURCE_URI, 'origen');
  const target = await openConnection(TARGET_URI, 'destino');

  const sourceDb = source.db;
  const targetDb = target.db;
  if (!sourceDb || !targetDb) throw new Error('Conexion sin handle de base de datos');

  const collections = (await sourceDb.listCollections().toArray())
    .map((info) => info.name)
    .sort();

  logger.info({ colecciones: collections.length, dryRun: DRY_RUN }, 'Inicio de copia');

  let totalCopiado = 0;
  const resumen: { coleccion: string; docs: number }[] = [];

  for (const name of collections) {
    const from = sourceDb.collection(name);
    const to = targetDb.collection(name);

    const total = await from.estimatedDocumentCount();
    if (total === 0) {
      logger.info({ coleccion: name }, 'vacia, se omite');
      resumen.push({ coleccion: name, docs: 0 });
      continue;
    }

    let copiado = 0;
    let operations: BulkOperation[] = [];

    // En dry-run igual se limpia el buffer: si no, el progreso se loguea por documento.
    const flush = async (): Promise<void> => {
      if (operations.length === 0) return;
      if (!DRY_RUN) {
        await to.bulkWrite(operations, { ordered: false });
      }
      copiado += operations.length;
      operations = [];
    };

    for await (const doc of from.find({})) {
      operations.push({
        replaceOne: {
          filter: { _id: doc['_id'] },
          replacement: doc,
          upsert: true,
        },
      });
      if (operations.length >= BATCH_SIZE) {
        await flush();
        logger.info({ coleccion: name, copiado, total }, 'progreso');
      }
    }
    await flush();

    const finales = DRY_RUN ? total : copiado;
    totalCopiado += finales;
    resumen.push({ coleccion: name, docs: finales });
    logger.info({ coleccion: name, docs: finales }, 'coleccion copiada');
  }

  logger.info({ totalColecciones: resumen.length, totalCopiado, dryRun: DRY_RUN }, 'Copia finalizada');

  await source.close();
  await target.close();
  process.exit(0);
};

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Copia fallida');
  process.exit(1);
});
