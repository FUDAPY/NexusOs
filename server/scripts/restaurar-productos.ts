/**
 * Restaura la coleccion `products` desde un backup de `backups_limpieza`.
 *
 *   npx tsx scripts/restaurar-productos.ts                      (muestra el backup mas nuevo)
 *   npx tsx scripts/restaurar-productos.ts --id=6ab2e89544efb50ebb739baf --aplicar
 *   npx tsx scripts/restaurar-productos.ts --etiqueta=reset-productos-2026-09-22T20:44:05.351Z --aplicar
 *   npx tsx scripts/restaurar-productos.ts --forzar --aplicar
 *
 * Sin `--aplicar` no escribe nada.
 * Si la coleccion `products` ya tiene documentos, aborta salvo `--forzar`
 * (para no mezclar dos inventarios distintos).
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { logger } from '../src/utils/logger.js';

const aplicar = process.argv.includes('--aplicar');
const forzar = process.argv.includes('--forzar');

const valorDe = (prefijo: string): string =>
  process.argv
    .filter((arg) => arg.startsWith(`${prefijo}=`))
    .map((arg) => arg.slice(prefijo.length + 1).trim())
    .filter((valor) => valor.length > 0)[0] ?? '';

const main = async (): Promise<void> => {
  await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 15_000 });

  const db = mongoose.connection.db;
  if (!db) throw new Error('Sin conexion a la base');

  const id = valorDe('--id');
  const etiqueta = valorDe('--etiqueta');
  const coleccion = 'products';

  const filtro = id !== ''
    ? { _id: new mongoose.Types.ObjectId(id) }
    : etiqueta !== ''
      ? { etiqueta, coleccion }
      : {};
  if (id === '' && etiqueta === '') {
    logger.info('Sin --id ni --etiqueta: se usa el backup mas reciente de products');
  }

  const backup = await db
    .collection('backups_limpieza')
    .find({ ...filtro, ...(id !== '' || etiqueta !== '' ? {} : { coleccion }) })
    .sort({ fecha: -1 })
    .limit(1)
    .next();

  if (!backup) throw new Error('No hay backup de products en backups_limpieza');

  const documentos = (backup['documentos'] as Record<string, unknown>[]) ?? [];
  const etiquetaBackup = String(backup['etiqueta'] ?? '');
  const fechaBackup = backup['fecha'] instanceof Date ? backup['fecha'].toISOString() : '';

  console.log(`Backup: ${etiquetaBackup} (${fechaBackup}) -> ${documentos.length} productos`);

  const yaHay = await db.collection(coleccion).countDocuments();
  console.log(`Productos actuales en Mongo: ${yaHay}`);

  if (!aplicar) {
    console.log('Simulacion: no se escribio nada. Agrega --aplicar para restaurar.');
    await mongoose.disconnect();
    process.exit(0);
  }

  if (yaHay > 0 && !forzar) {
    throw new Error(`La coleccion ${coleccion} no esta vacia (${yaHay}). Usa --forzar si queres igual.`);
  }

  const resultado = await db.collection(coleccion).insertMany(documentos, { ordered: false });
  console.log(JSON.stringify({ restaurados: resultado.insertedCount, etiqueta: etiquetaBackup }));

  await mongoose.disconnect();
  process.exit(0);
};

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Restauracion de productos fallida');
  process.exit(1);
});
