
import mongoose from 'mongoose';
import { AuditLog, CreditPin, ProductionBatch, ProductionConfig, User } from '../src/models/index.js';
import { env } from '../src/config/env.js';
import { logger } from '../src/utils/logger.js';


const PROHIBIDAS = ['orders', 'order_items', 'products'];


const CAMPOS_PRODUCCION = [
  'medallonesDisponibles',
  'medallonesIngresados',
  'medallonesConsumidos',
  'panesDisponibles',
  'panesIngresados',
  'panesConsumidos',
  'papasDisponibles',
  'papasIngresadas',
  'papasConsumidos',
  'carneSalteadoDisponible',
  'carneSalteadoIngresada',
  'carneSalteadoConsumida',
  'carneLomitoDisponible',
  'carneLomitoIngresada',
  'carneLomitoConsumida',
  'panLomitoDisponible',
  'panLomitoIngresado',
  'panLomitoConsumido',
];

const APLICAR = process.argv.includes('--aplicar');
const BORRAR_CLIENTES = process.argv.includes('--borrar-clientes');
const ETIQUETA = `limpieza-${new Date().toISOString()}`;

const objetivoDeLaColeccion = (nombre: string): void => {
  if (PROHIBIDAS.includes(nombre)) {
    throw new Error(
      `ABORTADO: el script intento tocar la coleccion prohibida '${nombre}'. ` +
        'Las ventas y los productos no se borran nunca.',
    );
  }
};


const respaldar = async (coleccion: string, docs: Record<string, unknown>[]): Promise<void> => {
  objetivoDeLaColeccion(coleccion);
  if (docs.length === 0) return;

  const db = mongoose.connection.db;
  if (!db) throw new Error('Sin conexion a la base');

  await db.collection('backups_limpieza').insertOne({
    etiqueta: ETIQUETA,
    coleccion,
    cantidad: docs.length,
    fecha: new Date(),
    documentos: docs,
  });
  logger.info({ coleccion, cantidad: docs.length }, 'Backup guardado en backups_limpieza');
};

const main = async (): Promise<void> => {
  await mongoose.connect(env.MONGO_URI);

  logger.info(
    { modo: APLICAR ? 'APLICA' : 'SOLO MUESTRA (dry-run)', borrarClientes: BORRAR_CLIENTES, etiqueta: ETIQUETA },
    'Limpieza de datos',
  );

  const configs = await ProductionConfig.find({}).lean().exec();
  const lotes = await ProductionBatch.find({}).lean().exec();
  const clientes = await User.find({ rol: 'cliente' }).select('_id nombre puntos deuda').lean().exec();
  const pines = await CreditPin.find({}).lean().exec();

  const num = (valor: unknown): number => Number(valor ?? 0);
  const conDeuda = clientes.filter((c) => num((c as { deuda?: number }).deuda) > 0).length;
  const conPuntos = clientes.filter((c) => num((c as { puntos?: number }).puntos) > 0).length;

  logger.info(
    {
      produccion: { configs: configs.length, lotes: lotes.length },
      clientes: { total: clientes.length, conDeuda, conPuntos },
      pines: pines.length,
      se_borraran_clientes: BORRAR_CLIENTES,
      NUNCA_se_toca: PROHIBIDAS,
    },
    APLICAR ? 'Esto es lo que se va a aplicar' : 'Esto es lo que se haria (no se escribe nada)',
  );

  if (!APLICAR) {
    logger.info('Dry-run terminado. Agrega --aplicar para hacerlo de verdad.');
    await mongoose.disconnect();
    return;
  }

  await respaldar('production_config', configs as unknown as Record<string, unknown>[]);
  await respaldar('production_batches', lotes as unknown as Record<string, unknown>[]);
  await respaldar('credit_pins', pines as unknown as Record<string, unknown>[]);
  await respaldar('users', clientes as unknown as Record<string, unknown>[]);


  const enCero: Record<string, number> = {};
  for (const campo of CAMPOS_PRODUCCION) enCero[campo] = 0;
  const rConfigs = await ProductionConfig.updateMany({}, { $set: enCero });
  const rLotes = await ProductionBatch.deleteMany({});

  // 2. Clientes: deuda y puntos en cero, y los PIN borrados.
  const rClientes = await User.updateMany(
    { rol: 'cliente' },
    { $set: { deuda: 0, puntos: 0, creditoPinConfigurado: false, solicitarPinCredito: false } },
  );
  const rPines = await CreditPin.deleteMany({});


  let clientesBorrados = 0;
  if (BORRAR_CLIENTES) {
    const r = await User.deleteMany({ rol: 'cliente' });
    clientesBorrados = Number(r.deletedCount ?? 0);
  }

  await AuditLog.create([
    {
      tipo: 'limpieza_datos',
      subtipo: BORRAR_CLIENTES ? 'clientes_borrados' : 'clientes_en_cero',
      motivo: `Limpieza de datos autorizada (${ETIQUETA})`,
      adminNombre: 'script limpiar-datos',
      detalle: {
        etiqueta: ETIQUETA,
        produccionConfigs: Number(rConfigs.modifiedCount ?? 0),
        produccionLotes: Number(rLotes.deletedCount ?? 0),
        clientesEnCero: Number(rClientes.modifiedCount ?? 0),
        pinesBorrados: Number(rPines.deletedCount ?? 0),
        clientesBorrados,
        prohibidas: PROHIBIDAS,
      },
    },
  ]);

  logger.info(
    {
      produccionConfigs: Number(rConfigs.modifiedCount ?? 0),
      produccionLotes: Number(rLotes.deletedCount ?? 0),
      clientesEnCero: Number(rClientes.modifiedCount ?? 0),
      pinesBorrados: Number(rPines.deletedCount ?? 0),
      clientesBorrados,
      backup: `backups_limpieza / ${ETIQUETA}`,
    },
    'Limpieza aplicada',
  );

  await mongoose.disconnect();
};

main().catch(async (error: unknown) => {
  logger.fatal({ err: error }, 'Limpieza fallida');
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
