import mongoose from 'mongoose';
import { Product } from '../models/index.js';
import { logger } from '../utils/logger.js';

export interface ResetProductosResultado {
  ok: true;
  aplicar: boolean;
  etiqueta: string;
  antes: number;
  borrados: number;
  backupId: string | null;
}

/**
 * Vacia SOLO la coleccion `products`, para volver a migrar los productos desde
 * Firestore sin arrastrar duplicados ni productos viejos.
 *
 * Que NO toca: `orders`, `order_items` e `inventory_movements` quedan intactos
 * (el historico de ventas y el kardex se conservan, como pidio el negocio).
 *
 * Que SI hace antes de borrar: guarda una copia completa en `backups_limpieza`
 * (mismo patron que scripts/limpiar-datos.ts), asi se puede restaurar.
 */
export const resetProductos = async (
  opciones: { aplicar: boolean },
): Promise<ResetProductosResultado> => {
  const { aplicar } = opciones;
  const etiqueta = `reset-productos-${new Date().toISOString()}`;

  const productos = await Product.find({}).lean().exec();
  const antes = productos.length;

  if (!aplicar || antes === 0) {
    return { ok: true, aplicar, etiqueta, antes, borrados: 0, backupId: null };
  }

  const db = mongoose.connection.db;
  if (!db) throw new Error('Sin conexion a la base');

  const backup = await db.collection('backups_limpieza').insertOne({
    etiqueta,
    coleccion: 'products',
    cantidad: antes,
    fecha: new Date(),
    motivo: 'reset para volver a migrar los productos desde Firestore',
    documentos: productos,
  });

  const resultado = await Product.deleteMany({});
  const borrados = Number(resultado.deletedCount ?? 0);

  logger.warn(
    { etiqueta, antes, borrados, backupId: String(backup.insertedId) },
    'Coleccion products vaciada (backup en backups_limpieza)',
  );

  return {
    ok: true,
    aplicar,
    etiqueta,
    antes,
    borrados,
    backupId: String(backup.insertedId),
  };
};

export interface DuplicadoProductos {
  clave: string;
  cantidad: number;
  ids: string[];
  nombres: string[];
}

export interface ReporteDuplicados {
  total: number;
  porCodigo: DuplicadoProductos[];
  porNombre: DuplicadoProductos[];
}

const normalizarClave = (valor: unknown): string =>
  String(valor ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * Reporte (solo lectura) de productos repetidos por `codigo` y por `nombre`.
 * Sirve para confirmar que la migracion no dejo duplicados.
 */
export const reporteDuplicadosProductos = async (): Promise<ReporteDuplicados> => {
  const productos = await Product.find({}).select('_id codigo nombre').lean().exec();

  const agrupar = (claveDe: (p: { codigo?: unknown; nombre?: unknown }) => string): DuplicadoProductos[] => {
    const grupos = new Map<string, { ids: string[]; nombres: string[] }>();

    for (const producto of productos) {
      const clave = normalizarClave(claveDe(producto));
      if (clave === '') continue;
      const actual = grupos.get(clave) ?? { ids: [], nombres: [] };
      actual.ids.push(String(producto._id));
      actual.nombres.push(String(producto.nombre ?? ''));
      grupos.set(clave, actual);
    }

    return [...grupos.entries()]
      .filter(([, valor]) => valor.ids.length > 1)
      .map(([clave, valor]) => ({
        clave,
        cantidad: valor.ids.length,
        ids: valor.ids,
        nombres: valor.nombres,
      }));
  };

  return {
    total: productos.length,
    porCodigo: agrupar((p) => String(p.codigo ?? '')),
    porNombre: agrupar((p) => String(p.nombre ?? '')),
  };
};
