/**
 * Reporte (solo lectura) de productos repetidos por `codigo` y por `nombre`.
 * Se usa para confirmar que la re-migracion de Firestore no dejo duplicados.
 *
 *   npx tsx scripts/reportar-duplicados.ts
 *   npm run productos:duplicados
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { logger } from '../src/utils/logger.js';
import { reporteDuplicadosProductos } from '../src/services/resetProductos.service.js';

const main = async (): Promise<void> => {
  await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 15_000 });

  const reporte = await reporteDuplicadosProductos();

  console.log(`Total de productos en Mongo: ${reporte.total}`);
  console.log(`Duplicados REALES (mismo nombre y misma sucursal): ${reporte.reales.length}`);
  console.log(`Mismo nombre en sucursales distintas (informativo): ${reporte.porNombre.length}`);
  console.log(`Repetidos por codigo: ${reporte.porCodigo.length}`);

  if (reporte.reales.length > 0) {
    console.log('--- DUPLICADOS REALES ---');
    console.log(JSON.stringify(reporte.reales, null, 2));
  }
  if (reporte.porCodigo.length > 0) {
    console.log('--- REPETIDOS POR CODIGO ---');
    console.log(JSON.stringify(reporte.porCodigo, null, 2));
  }
  if (reporte.porNombre.length > 0 && reporte.reales.length === 0) {
    console.log('--- MISMO NOMBRE EN SUCURSALES DISTINTAS ---');
    console.log(JSON.stringify(reporte.porNombre, null, 2));
  }

  await mongoose.disconnect();
  process.exit(0);
};

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Reporte de duplicados fallido');
  process.exit(1);
});
