/**
 * Vacia la coleccion `products` (SOLO productos) para volver a migrarlos desde
 * Firestore. Las ventas y los movimientos de inventario NO se tocan.
 *
 * Antes de borrar guarda todo en `backups_limpieza`.
 *
 *   npx tsx scripts/reset-productos.ts            simulacion (no borra nada)
 *   npx tsx scripts/reset-productos.ts --aplicar  borra de verdad
 *
 * En produccion Mongo no esta publicado: alli se usa el endpoint de admin
 * POST /admin/reset-productos (misma logica, este servicio).
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { logger } from '../src/utils/logger.js';
import { resetProductos } from '../src/services/resetProductos.service.js';

const aplicar = process.argv.includes('--aplicar');

const main = async (): Promise<void> => {
  await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 15_000 });

  logger.info({ modo: aplicar ? 'APLICA' : 'SOLO MUESTRA (dry-run)' }, 'Reset de productos');

  const resumen = await resetProductos({ aplicar });
  console.log(JSON.stringify(resumen, null, 2));

  await mongoose.disconnect();
  process.exit(0);
};

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Reset de productos fallido');
  process.exit(1);
});
