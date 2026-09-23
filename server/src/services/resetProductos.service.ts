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
  sucursales: string[];
  precios: number[];
  stocks: number[];
  controlados: boolean[];
  visibilidades: string[];
}

export interface ReporteDuplicados {
  total: number;
  /* Duplicados REALES: mismo nombre y misma sucursal (dos documentos del mismo producto). */
  reales: DuplicadoProductos[];
  /* Informativo: mismo nombre en sucursales distintas (puede ser legitimo). */
  porNombre: DuplicadoProductos[];
  porCodigo: DuplicadoProductos[];
}

const normalizarClave = (valor: unknown): string =>
  String(valor ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

interface FilaProducto {
  _id: mongoose.Types.ObjectId;
  nombre?: unknown;
  codigo?: unknown;
  sucursal?: unknown;
  precio?: unknown;
  stock?: unknown;
  controlado?: unknown;
  visibilidad?: unknown;
}

/**
 * Reporte (solo lectura) de productos repetidos por `codigo`, por `nombre` y por
 * `nombre + sucursal`. Este ultimo es el que importa: dos documentos con el mismo
 * nombre en la MISMA sucursal son un duplicado real; el mismo nombre en otra
 * sucursal puede ser legitimo (carta por sucursal).
 */
export const reporteDuplicadosProductos = async (): Promise<ReporteDuplicados> => {
  const productos = await Product.find({})
    .select('_id nombre codigo sucursal precio stock controlado visibilidad')
    .lean<FilaProducto[]>()
    .exec();

  const agrupar = (claveDe: (p: FilaProducto) => string): DuplicadoProductos[] => {
    const grupos = new Map<string, DuplicadoProductos>();

    for (const producto of productos) {
      const clave = normalizarClave(claveDe(producto));
      if (clave === '') continue;

      const actual = grupos.get(clave) ?? {
        clave,
        cantidad: 0,
        ids: [],
        nombres: [],
        sucursales: [],
        precios: [],
        stocks: [],
        controlados: [],
        visibilidades: [],
      };

      actual.cantidad += 1;
      actual.ids.push(String(producto._id));
      actual.nombres.push(String(producto.nombre ?? ''));
      actual.sucursales.push(String(producto.sucursal ?? ''));
      actual.precios.push(Number(producto.precio ?? 0));
      actual.stocks.push(Number(producto.stock ?? 0));
      actual.controlados.push(producto.controlado === true);
      actual.visibilidades.push(String(producto.visibilidad ?? ''));
      grupos.set(clave, actual);
    }

    return [...grupos.values()].filter((grupo) => grupo.cantidad > 1);
  };

  return {
    total: productos.length,
    reales: agrupar((p) => `${String(p.nombre ?? '')}|${String(p.sucursal ?? '')}`),
    porNombre: agrupar((p) => String(p.nombre ?? '')),
    porCodigo: agrupar((p) => String(p.codigo ?? '')),
  };
};

