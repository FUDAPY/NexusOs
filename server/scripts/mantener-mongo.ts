
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';

const aplicar = process.argv.includes('--aplicar');
const soloIndices = process.argv.includes('--indices');
const soloNormalizar = process.argv.includes('--normalizar');

const linea = (s: string): void => console.log(s);





interface DefinicionIndice {
  coleccion: string;
  campos: Record<string, 1 | -1>;
  nombre: string;
}

const INDICES: DefinicionIndice[] = [

  { coleccion: 'orders', nombre: 'sucursal_fecha', campos: { sucursal: 1, fecha: -1 } },
  { coleccion: 'orders', nombre: 'ticket_id', campos: { ticket_id: 1 } },
  { coleccion: 'orders', nombre: 'cliente', campos: { cliente: 1 } },
  { coleccion: 'orders', nombre: 'estadoPago', campos: { estadoPago: 1 } },
  { coleccion: 'orders', nombre: 'estadoCocina', campos: { estadoCocina: 1 } },
  { coleccion: 'orders', nombre: 'turnoId', campos: { turnoId: 1 } },


  { coleccion: 'order_items', nombre: 'orderId', campos: { orderId: 1 } },
  { coleccion: 'order_items', nombre: 'productoId', campos: { productoId: 1 } },
  { coleccion: 'order_items', nombre: 'fecha', campos: { fecha: -1 } },


  { coleccion: 'products', nombre: 'sucursal_estado', campos: { sucursal: 1, estado: 1 } },
  { coleccion: 'products', nombre: 'categoria', campos: { categoria: 1 } },
  { coleccion: 'products', nombre: 'controlado', campos: { controlado: 1 } },
  { coleccion: 'products', nombre: 'nombre', campos: { nombre: 1 } },


  { coleccion: 'cash_shifts', nombre: 'sucursal_estado', campos: { sucursal: 1, estadoTurno: 1 } },
  { coleccion: 'cash_shifts', nombre: 'fechaApertura', campos: { fechaApertura: -1 } },
  { coleccion: 'cash_closes', nombre: 'sucursal', campos: { sucursal: 1 } },
  { coleccion: 'cash_closes', nombre: 'fechaCierre', campos: { fechaCierre: -1 } },

  // --- inventario y auditoria ---
  { coleccion: 'inventory_movements', nombre: 'productoId', campos: { productoId: 1 } },
  { coleccion: 'inventory_movements', nombre: 'fecha', campos: { fecha: -1 } },
  { coleccion: 'inventory_movements', nombre: 'ventaId', campos: { ventaId: 1 } },
  { coleccion: 'audit_logs', nombre: 'fecha', campos: { fecha: -1 } },
  { coleccion: 'audit_logs', nombre: 'tipo', campos: { tipo: 1 } },


  { coleccion: 'support_alerts', nombre: 'estado', campos: { estado: 1 } },
  { coleccion: 'sync_logs', nombre: 'fecha', campos: { fecha: -1 } },


  { coleccion: 'users', nombre: 'rol', campos: { rol: 1 } },
  { coleccion: 'users', nombre: 'sucursal', campos: { sucursal: 1 } },
  { coleccion: 'branches', nombre: 'nombre', campos: { nombre: 1 } },
  { coleccion: 'categories', nombre: 'orden', campos: { orden: 1 } },
];

const crearIndices = async (): Promise<void> => {
  linea('=== FASE 2.5 - INDICES ===');
  linea('');

  const db = mongoose.connection.db;
  if (db === undefined) throw new Error('Sin conexion a la base');

  let creados = 0;
  let yaExistian = 0;
  let fallidos = 0;

  for (const def of INDICES) {
    const col = db.collection(def.coleccion);
    try {
      const existentes = await col.indexes();
      const ya = existentes.some((i) => i.name === def.nombre);
      await col.createIndex(def.campos, { name: def.nombre });
      if (ya) {
        yaExistian++;
        linea(`  = ${def.coleccion.padEnd(22)} ${def.nombre}`);
      } else {
        creados++;
        linea(`  + ${def.coleccion.padEnd(22)} ${def.nombre}`);
      }
    } catch (e) {
      fallidos++;
      linea(`  ! ${def.coleccion.padEnd(22)} ${def.nombre}  -> ${(e as Error).message}`);
    }
  }

  linea('');
  linea(`  creados: ${String(creados)}   ya existian: ${String(yaExistian)}   fallidos: ${String(fallidos)}`);
};






const FECHAS_A_CONVERTIR: { coleccion: string; campo: string }[] = [
  { coleccion: 'orders', campo: 'fecha' },
  { coleccion: 'orders', campo: 'fechaArqueo' },
  { coleccion: 'order_items', campo: 'fecha' },
  { coleccion: 'users', campo: 'fechaRegistro' },
];

const normalizar = async (): Promise<void> => {
  linea('=== FASE 2.6 - NORMALIZACION ===');
  linea(aplicar ? '  MODO: APLICAR' : '  MODO: simulacion (agregar --aplicar para ejecutar)');
  linea('');

  const db = mongoose.connection.db;
  if (db === undefined) throw new Error('Sin conexion a la base');


  const products = db.collection('products');
  const conStockNull = await products.countDocuments({ stock: null });
  linea(`  products.stock = null .................. ${String(conStockNull)} docs`);
  if (conStockNull > 0 && aplicar) {
    const r = await products.updateMany({ stock: null }, { $set: { stock: 0 } });
    linea(`     -> corregidos: ${String(r.modifiedCount)}`);
  }


  for (const { coleccion, campo } of FECHAS_A_CONVERTIR) {
    const col = db.collection(coleccion);
    const total = await col.countDocuments({ [campo]: { $type: 'string' } });
    linea(`  ${`${coleccion}.${campo}`.padEnd(36)} ${String(total)} docs`);

    if (total === 0 || !aplicar) continue;


    const cursor = col.find({ [campo]: { $type: 'string' } });
    let convertidos = 0;
    let invalidos = 0;
    for await (const doc of cursor) {
      const crudo = (doc as Record<string, unknown>)[campo];
      const fecha = new Date(String(crudo));
      if (Number.isNaN(fecha.getTime())) {
        invalidos++;
        continue;
      }
      await col.updateOne({ _id: doc._id }, { $set: { [campo]: fecha } });
      convertidos++;
    }
    linea(`     -> convertidos: ${String(convertidos)}   invalidos sin tocar: ${String(invalidos)}`);
  }
};



const main = async (): Promise<void> => {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 15_000 });
  linea(`Base: ${env.MONGO_DB_NAME}`);
  linea('');

  if (!soloNormalizar) await crearIndices();
  if (!soloIndices) {
    linea('');
    await normalizar();
  }

  await mongoose.connection.close();
};

main().catch((error: unknown) => {
  console.error('Fallo:', error);
  process.exit(1);
});
