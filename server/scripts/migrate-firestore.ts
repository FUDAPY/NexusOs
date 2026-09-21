/**
 * ETL Firestore -> MongoDB (CLI).
 *
 * La logica vive en `src/services/migracionFirestore.service.ts` a proposito: asi la puede
 * correr tambien el API (endpoint de admin), que es la unica forma de hacerlo contra la base
 * de produccion (Mongo no esta publicado a internet).
 *
 *   npx tsx scripts/migrate-firestore.ts                          simulacion (no escribe)
 *   npx tsx scripts/migrate-firestore.ts --aplicar                migra todo
 *   npx tsx scripts/migrate-firestore.ts --aplicar --only=orders  una coleccion
 *   npx tsx scripts/migrate-firestore.ts --aplicar --derive-only  solo derivados
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { logger } from '../src/utils/logger.js';
import {
  ALL_DERIVES,
  migrarFirestore,
  type DeriveTarget,
  type MigracionEvento,
} from '../src/services/migracionFirestore.service.js';

const aplicar = process.argv.includes('--aplicar');
const soloDerivados = process.argv.includes('--derive-only');

const only = process.argv
  .filter((arg) => arg.startsWith('--only='))
  .flatMap((arg) => arg.slice('--only='.length).split(','))
  .map((value) => value.trim())
  .filter((value) => value.length > 0);

const derive = process.argv
  .filter((arg) => arg.startsWith('--derive='))
  .flatMap((arg) => arg.slice('--derive='.length).split(','))
  .map((value) => value.trim())
  .filter((value): value is DeriveTarget => (ALL_DERIVES as readonly string[]).includes(value));

const alProgreso = (evento: MigracionEvento): void => {
  if (evento.tipo === 'coleccion:fin') {
    logger.info(
      { target: evento.target, leidos: evento.leidos, escritos: evento.escritos },
      'coleccion lista',
    );
  }
};

const main = async (): Promise<void> => {
  await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 15_000 });
  const resumen = await migrarFirestore({ aplicar, only, derive, soloDerivados, alProgreso });
  console.log(JSON.stringify(resumen, null, 2));
  await mongoose.disconnect();
  process.exit(0);
};

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Migracion fallida');
  process.exit(1);
});
