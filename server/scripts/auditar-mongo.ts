/**
 * Fase 1 - Auditoria de MongoDB.
 *
 * Lee la base real y reporta, coleccion por coleccion:
 *   - cantidad de documentos
 *   - que campos tiene y de que tipo
 *   - campos con TIPOS MEZCLADOS (ej: controlado como boolean y como string)
 *   - indices existentes
 *   - campos de filtro que NO tienen indice
 *
 * Solo lectura. No modifica nada.
 *
 * Uso:  npm run auditar:mongo
 *       npm run auditar:mongo -- --muestras 200 --salida docs/paridad.json
 */
import mongoose from 'mongoose';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../src/config/env.js';

interface Args {
  muestras: number;
  salida: string;
}

const leerArgs = (): Args => {
  const argv = process.argv.slice(2);
  const valor = (nombre: string, porDefecto: string): string => {
    const conIgual = argv.find((a) => a.startsWith(`--${nombre}=`));
    if (conIgual !== undefined) return conIgual.split('=').slice(1).join('=');
    const idx = argv.indexOf(`--${nombre}`);
    return idx >= 0 && argv[idx + 1] !== undefined ? String(argv[idx + 1]) : porDefecto;
  };
  return {
    muestras: Number(valor('muestras', '150')) || 150,
    salida: valor('salida', 'docs/paridad.json'),
  };
};

/** Tipo legible de un valor. Distingue int de double y detecta ObjectId/fecha. */
const tipoDe = (valor: unknown): string => {
  if (valor === null) return 'null';
  if (valor === undefined) return 'undefined';
  if (Array.isArray(valor)) return 'array';
  if (valor instanceof Date) return 'date';
  if (valor instanceof mongoose.Types.ObjectId) return 'objectId';
  const t = typeof valor;
  if (t === 'number') return Number.isInteger(valor as number) ? 'int' : 'double';
  return t;
};

interface InfoCampo {
  tipos: Map<string, number>;
  ejemplos: unknown[];
}

interface InfoColeccion {
  coleccion: string;
  documentos: number;
  muestreados: number;
  campos: Map<string, InfoCampo>;
  indices: { nombre: string; campos: string[] }[];
}

const auditarColeccion = async (nombre: string, muestras: number): Promise<InfoColeccion> => {
  const col = mongoose.connection.db?.collection(nombre);
  if (col === undefined) {
    return { coleccion: nombre, documentos: -1, muestreados: 0, campos: new Map(), indices: [] };
  }

  const documentos = await col.estimatedDocumentCount();
  const docs = await col.find({}).limit(muestras).toArray();

  const campos = new Map<string, InfoCampo>();
  for (const doc of docs) {
    for (const [clave, valor] of Object.entries(doc)) {
      let info = campos.get(clave);
      if (info === undefined) {
        info = { tipos: new Map(), ejemplos: [] };
        campos.set(clave, info);
      }
      const t = tipoDe(valor);
      info.tipos.set(t, (info.tipos.get(t) ?? 0) + 1);
      if (info.ejemplos.length < 2 && valor !== null && valor !== undefined && typeof valor !== 'object') {
        info.ejemplos.push(valor);
      }
    }
  }

  const indicesRaw = await col.indexes().catch((): Record<string, unknown>[] => []);
  const indices = indicesRaw.map((i) => ({
    nombre: String(i['name'] ?? ''),
    campos: Object.keys((i['key'] ?? {}) as Record<string, unknown>),
  }));

  return { coleccion: nombre, documentos, muestreados: docs.length, campos, indices };
};

const main = async (): Promise<void> => {
  const args = leerArgs();

  console.log('=== FASE 1 - AUDITORIA DE MONGODB ===');
  console.log(`  base    : ${env.MONGO_DB_NAME}`);
  console.log(`  muestras: ${String(args.muestras)} documentos por coleccion`);
  console.log('');

  mongoose.set('strictQuery', true);
  await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 15_000 });

  const db = mongoose.connection.db;
  if (db === undefined) throw new Error('Sin conexion a la base');

  const lista = await db.listCollections().toArray();
  const nombres = lista
    .map((c) => c.name)
    .filter((n) => !n.startsWith('system.'))
    .sort();

  console.log(`  colecciones encontradas: ${String(nombres.length)}`);
  console.log('');
  console.log('  COLECCION                  DOCS   CAMPOS  IDX');
  console.log('  ------------------------- ------- ------ ----');

  const resultados: InfoColeccion[] = [];
  for (const nombre of nombres) {
    const info = await auditarColeccion(nombre, args.muestras);
    resultados.push(info);

    const mezclados: string[] = [];
    for (const [campo, f] of info.campos) {
      if (f.tipos.size > 1) {
        const detalle = [...f.tipos.entries()].map(([t, n]) => `${t}:${String(n)}`).join(' ');
        mezclados.push(`${campo} (${detalle})`);
      }
    }

    const marca = mezclados.length > 0 ? '   <-- TIPOS MEZCLADOS' : '';
    console.log(
      `  ${nombre.padEnd(25)} ${String(info.documentos).padStart(7)} ${String(info.campos.size).padStart(6)} ${String(info.indices.length).padStart(4)}${marca}`,
    );
    for (const m of mezclados.slice(0, 5)) console.log(`        ! ${m}`);
  }

  console.log('');
  console.log('=== CAMPOS DE FILTRO SIN INDICE ===');
  const candidatos = [
    'sucursal', 'sucursalId', 'fecha', 'fechaApertura', 'estado',
    'estadoTurno', 'ticket_id', 'cliente', 'productoId', 'controlado',
  ];
  let sinIndice = 0;
  for (const r of resultados) {
    if (r.documentos < 100) continue;
    const conIndice = new Set(r.indices.flatMap((i) => i.campos));
    const faltan = candidatos.filter((c) => r.campos.has(c) && !conIndice.has(c));
    if (faltan.length > 0) {
      console.log(`  ${r.coleccion.padEnd(25)} ${faltan.join(', ')}`);
      sinIndice++;
    }
  }
  if (sinIndice === 0) console.log('  (ninguna)');

  const json = {
    generadoEn: new Date().toISOString(),
    base: env.MONGO_DB_NAME,
    muestras: args.muestras,
    totalColecciones: nombres.length,
    colecciones: resultados.map((r) => ({
      nombre: r.coleccion,
      documentos: r.documentos,
      campos: Object.fromEntries(
        [...r.campos.entries()].map(([c, f]) => [
          c,
          { tipos: Object.fromEntries(f.tipos), ejemplos: f.ejemplos },
        ]),
      ),
      indices: r.indices,
    })),
  };

  const destino = path.resolve(process.cwd(), '..', args.salida);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, JSON.stringify(json, null, 2), 'utf8');
  console.log('');
  console.log(`  reporte escrito en: ${destino}`);

  await mongoose.connection.close();
};

main().catch((error: unknown) => {
  console.error('Fallo la auditoria:', error);
  process.exit(1);
});
