import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { initializeApp, cert, applicationDefault, type App, type ServiceAccount } from 'firebase-admin/app';
import {
  getFirestore,
  Timestamp,
  GeoPoint,
  DocumentReference,
  type Firestore,
  type QuerySnapshot,
} from 'firebase-admin/firestore';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';



interface CollectionPlan {
  
  readonly source: string;
  
  readonly target: string;
  
  readonly batchSize?: number;
}

const DEFAULT_BATCH_SIZE = 400;

const PLANS: readonly CollectionPlan[] = [
  { source: 'users', target: 'users' },
  { source: 'branches', target: 'branches' },
  { source: 'products', target: 'products' },
  { source: 'cashFlows', target: 'cash_shifts' },

  { source: 'cierresCaja', target: 'cash_closes', batchSize: 20 },
  { source: 'cashFlowAudits', target: 'cash_flow_audits' },
  { source: 'cashFlowContributions', target: 'cash_flow_contributions' },
  { source: 'auditoria', target: 'audit_logs' },
  { source: 'systemAlerts', target: 'support_alerts' },
  { source: 'inventoryMovements', target: 'inventory_movements' },
  { source: 'syncLog', target: 'sync_logs' },
  { source: 'config', target: 'settings' },
  { source: 'settings', target: 'settings' },
  { source: 'linTickets', target: 'lin_tickets' },
  { source: 'linTicketClaims', target: 'lin_ticket_claims' },
  { source: 'creditPins', target: 'credit_pins' },
  { source: 'creditPinAttempts', target: 'credit_pin_attempts' },
  { source: 'passwordResetOtps', target: 'password_reset_otps' },
  { source: 'passwordResetRateLimits', target: 'password_reset_rate_limits' },
  { source: 'produccionLotes', target: 'production_batches' },
  { source: 'produccionConfig', target: 'production_config' },
  { source: 'publicGoals', target: 'public_goals' },
  { source: 'playTesterRequests', target: 'play_tester_requests' },
  { source: 'notifications', target: 'notifications' },

  { source: env.FIREBASE_SALES_PATH, target: 'orders', batchSize: 200 },
];

export const ALL_DERIVES = ['items', 'currencies', 'categories'] as const;
export type DeriveTarget = (typeof ALL_DERIVES)[number];

export interface MigracionEvento {
  tipo: 'coleccion:inicio' | 'coleccion:fin' | 'derivados' | 'fin';
  target?: string;
  leidos?: number;
  escritos?: number;
  derivados?: { items: number; currencies: number; categories: number };
}

export interface MigracionOpciones {
  /** `true` escribe; por defecto es simulacion (no toca Mongo). */
  aplicar?: boolean;
  /** Colecciones destino a migrar. Vacio = todas. */
  only?: readonly string[];
  /** Derivados a generar. Vacio = los que correspondan a `only`. */
  derive?: readonly DeriveTarget[];
  /** Solo derivados: no lee Firestore. */
  soloDerivados?: boolean;
  /** Aviso de progreso: lo usa el endpoint que corre esto en segundo plano. */
  alProgreso?: (evento: MigracionEvento) => void;
}

export interface MigracionResumen {
  aplicar: boolean;
  colecciones: MigrationResult[];
  derivados: { items: number; currencies: number; categories: number };
  documentosLeidos: number;
  documentosEscritos: number;
  duracionMs: number;
}

type MongoPrimitive = string | number | boolean | Date | null;
type MongoValue = MongoPrimitive | MongoValue[] | { [key: string]: MongoValue };
type MongoDoc = { [key: string]: MongoValue | mongoose.Types.ObjectId };


const initFirebase = (): App => {
  const serviceAccountJson = (env.FIREBASE_SERVICE_ACCOUNT_JSON ?? '').trim();
  if (serviceAccountJson.length > 0) {
    const credenciales = JSON.parse(serviceAccountJson) as ServiceAccount;
    return initializeApp({
      credential: cert(credenciales),
      projectId: env.FIREBASE_PROJECT_ID ?? credenciales.projectId,
    });
  }

  const serviceAccountPath = (env.FIREBASE_SERVICE_ACCOUNT_PATH ?? '').trim();
  if (serviceAccountPath.length > 0) {
    let projectId = env.FIREBASE_PROJECT_ID;
    try {
      const raw = JSON.parse(readFileSync(serviceAccountPath, 'utf8')) as { project_id?: string };
      projectId = projectId ?? raw.project_id;
    } catch {
      logger.warn({ serviceAccountPath }, 'No se pudo leer el project_id del service account');
    }
    return initializeApp({ credential: cert(serviceAccountPath), projectId });
  }
  return initializeApp({ credential: applicationDefault(), projectId: env.FIREBASE_PROJECT_ID });
};


const toMongoValue = (value: unknown): MongoValue => {
  if (value === null || value === undefined) return null;
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  if (value instanceof GeoPoint) {
    return { type: 'Point', coordinates: [value.longitude, value.latitude] };
  }
  if (value instanceof DocumentReference) return value.path;
  if (Array.isArray(value)) return value.map((entry) => toMongoValue(entry));

  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;

    if (typeof source['_seconds'] === 'number' && typeof source['_nanoseconds'] === 'number') {
      return new Date(source['_seconds'] * 1000 + Math.floor(source['_nanoseconds'] / 1_000_000));
    }
    const entries = Object.entries(source).map(
      ([key, entry]) => [key, toMongoValue(entry)] as const,
    );
    return Object.fromEntries(entries);
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return JSON.stringify(value);
};


const resolveId = (docId: string): { _id: mongoose.Types.ObjectId; legacyId?: string } =>
  /^[a-f\d]{24}$/i.test(docId)
    ? { _id: new mongoose.Types.ObjectId(docId) }
    : { _id: new mongoose.Types.ObjectId(), legacyId: docId };

type BulkOperation = mongoose.mongo.AnyBulkWriteOperation;

interface MigrationResult {
  readonly target: string;
  readonly source: string;
  readonly read: number;
  readonly upserted: number;
  readonly modified: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));


const RETRYABLE = /DEADLINE_EXCEEDED|UNAVAILABLE|RESOURCE_EXHAUSTED|ETIMEDOUT|ECONNRESET|socket hang up/i;

const withRetry = async <T>(label: string, work: () => Promise<T>, attempts = 4): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!RETRYABLE.test(message) || attempt === attempts) break;
      const waitMs = 2_000 * attempt;
      logger.warn({ label, attempt, waitMs, message }, 'Reintentando lectura de Firestore');
      await sleep(waitMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};


const migrateCollection = async (
  db: mongoose.mongo.Db,
  firestore: Firestore,
  plan: CollectionPlan,
  aplicar: boolean,
): Promise<MigrationResult> => {
  const source = firestore.collection(plan.source);
  const target = db.collection(plan.target);
  const pageSize = plan.batchSize ?? DEFAULT_BATCH_SIZE;

  let read = 0;
  let upserted = 0;
  let modified = 0;
  let lastId: string | null = null;

  for (;;) {
    const base = source.orderBy('__name__').limit(pageSize);
    const snapshot: QuerySnapshot = await withRetry(`${plan.target}:read`, () =>
      lastId === null ? base.get() : base.startAfter(lastId).get(),
    );
    if (snapshot.empty) break;

    const operations: BulkOperation[] = snapshot.docs.map((doc) => {
      const { _id, legacyId } = resolveId(doc.id);
      const payload = toMongoValue(doc.data()) as MongoDoc;
      const document: MongoDoc = legacyId ? { ...payload, _id, legacyId } : { ...payload, _id };
      return { replaceOne: { filter: { _id }, replacement: document, upsert: true } };
    });

    if (aplicar) {
      const result = await withRetry(`${plan.target}:write`, () =>
        target.bulkWrite(operations, { ordered: false }),
      );
      upserted += result.upsertedCount;
      modified += result.modifiedCount;
    }

    read += snapshot.size;
    lastId = snapshot.docs[snapshot.docs.length - 1]?.id ?? null;
    logger.info({ target: plan.target, read, pageSize }, 'pagina leida');
    if (snapshot.size < pageSize) break;
  }

  return { target: plan.target, source: plan.source, read, upserted, modified };
};

/* Deriva order_items desde orders.items con _id determinista (idempotente). */
interface OrderSource {
  _id: mongoose.Types.ObjectId;
  items?: unknown;
  sucursal?: unknown;
  fecha?: unknown;
  ticket_id?: unknown;
}

const deriveOrderItems = async (db: mongoose.mongo.Db, aplicar: boolean): Promise<number> => {
  const orders = db.collection<OrderSource>('orders');
  const target = db.collection('order_items');

  const total = await orders.estimatedDocumentCount();
  let processed = 0;
  let written = 0;
  let lastId: mongoose.Types.ObjectId | null = null;

  for (;;) {
    const filter: mongoose.mongo.Filter<OrderSource> =
      lastId === null ? {} : { _id: { $gt: lastId } };
    const page = await orders
      .find(filter, { projection: { items: 1, sucursal: 1, sucursalId: 1, fecha: 1, ticket_id: 1 } })
      .sort({ _id: 1 })
      .limit(DEFAULT_BATCH_SIZE)
      .toArray();

    if (page.length === 0) break;

    const operations: BulkOperation[] = [];
    for (const order of page) {
      const items = Array.isArray(order.items) ? (order.items as Record<string, unknown>[]) : [];
      items.forEach((item, index) => {
        const rawId = typeof item['id'] === 'string' ? item['id'] : '';
        const key = `${String(order._id)}:${index}:${rawId}`;
        const _id = new mongoose.Types.ObjectId(digest12(key));

        const precio = Number(item['precio'] ?? 0);
        const cantidad = Number(item['cantidad'] ?? 0);
        const descuentos =
          Number(item['descuento'] ?? 0) + Number(item['descuentoVip'] ?? 0) + Number(item['descuentoBogo'] ?? 0);

        operations.push({
          replaceOne: {
            filter: { _id },
            replacement: {
              _id,
              orderId: order._id,
              productoId: rawId,
              nombre: text(item['nombre']),
              categoria: text(item['categoria'], 'Sin Categoria'),
              cantidad,
              precio,
              descuento: descuentos,
              promocionBogo: item['promocionBogo'] === true,
              codigo: text(item['codigo']),
              icono: text(item['icono'], 'fa-box'),
              controlado: item['controlado'] === true,
              obsProd: text(item['obsProd']),
              subtotal: Math.max(cantidad * precio - descuentos, 0),
              ticket_id: text(order.ticket_id),
              sucursal: text(order.sucursal, 'Unificado'),
              fecha: order.fecha ?? null,
            },
            upsert: true,
          },
        });
      });
    }

    if (aplicar && operations.length > 0) {
      await target.bulkWrite(operations, { ordered: false });
      written += operations.length;
    }

    processed += page.length;
    lastId = page[page.length - 1]?._id ?? null;
    logger.info({ processed, total }, 'order_items: progreso');
    if (page.length < DEFAULT_BATCH_SIZE) break;
  }

  return written;
};

const digest12 = (value: string): Buffer => createHash('sha1').update(value).digest().subarray(0, 12);


const text = (value: unknown, fallback = ''): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
};


const slugify = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const CURRENCY_META: Record<string, { nombre: string; simbolo: string; decimales: number }> = {
  PYG: { nombre: 'Guarani Paraguayo', simbolo: 'Gs.', decimales: 0 },
  USD: { nombre: 'Dolar Estadounidense', simbolo: 'USD', decimales: 2 },
  ARS: { nombre: 'Peso Argentino', simbolo: 'ARS', decimales: 2 },
  BRL: { nombre: 'Real Brasileno', simbolo: 'BRL', decimales: 2 },
};

/* Deriva currencies desde settings/sistema.divisas (tasas expresadas en PYG por unidad). */
const deriveCurrencies = async (db: mongoose.mongo.Db, aplicar: boolean): Promise<number> => {
  const settings = await db.collection('settings').findOne({ divisas: { $exists: true } });
  if (!settings) {
    logger.warn('No se encontro el documento settings/sistema.divisas; currencies sin generar');
    return 0;
  }

  const divisas = settings['divisas'] as Record<string, number>;
  const fecha = settings['fechaActualizacionCambio'];
  const actualizadoEn = typeof fecha === 'number' ? new Date(fecha) : new Date();
  const codes = ['PYG', ...Object.keys(divisas).filter((codigo) => codigo !== 'PYG')];
  const target = db.collection('currencies');

  let count = 0;
  for (const codigo of codes) {
    const info = CURRENCY_META[codigo] ?? { nombre: codigo, simbolo: codigo, decimales: 2 };
    const esBase = codigo === 'PYG';
    const tasa = esBase ? 1 : Number(divisas[codigo] ?? 0);
    if (aplicar) {
      await target.replaceOne(
        { codigo },
        {
          codigo,
          nombre: info.nombre,
          simbolo: info.simbolo,
          decimales: info.decimales,
          esBase,
          tasaCompra: tasa,
          tasaVenta: tasa,
          activa: true,
          actualizadoEn,
          origen: 'derivado:settings/sistema.divisas',
        },
        { upsert: true },
      );
    }
    count += 1;
  }
  return count;
};


const deriveCategories = async (db: mongoose.mongo.Db, aplicar: boolean): Promise<number> => {
  const nombres = await db.collection('products').distinct('categoria');
  const target = db.collection('categories');
  const seen = new Set<string>();

  let count = 0;
  for (const raw of nombres) {
    const nombre = String(raw ?? '').trim();
    if (nombre.length === 0 || seen.has(nombre.toLowerCase())) continue;
    seen.add(nombre.toLowerCase());

    const slug = slugify(nombre);
    if (slug.length === 0) continue;

    if (aplicar) {
      await target.replaceOne(
        { slug },
        {
          nombre,
          slug,
          icono: 'fa-utensils',
          color: '#0f172a',
          orden: count,
          estado: 'activa',
          visibleEnPos: true,
          origen: 'derivado:products.categoria',
        },
        { upsert: true },
      );
    }
    count += 1;
  }
  return count;
};

/**
 * Migra TODO Firestore -> MongoDB. Idempotente: hace upsert por `_id`/`legacyId`, asi que se
 * puede correr las veces que haga falta (y de nuevo el dia del corte).
 *
 * NO abre ni cierra Mongo: usa la conexion que ya existe (el API ya esta conectado). El CLI
 * (`scripts/migrate-firestore.ts`) es el que conecta y desconecta.
 */
export const migrarFirestore = async (opciones: MigracionOpciones = {}): Promise<MigracionResumen> => {
  const aplicar = opciones.aplicar === true;
  const only = [...(opciones.only ?? [])];
  const derives = [...(opciones.derive ?? [])];
  const soloDerivados = opciones.soloDerivados === true;
  const avisar = opciones.alProgreso ?? ((): void => undefined);
  const inicio = Date.now();

  const firestore = getFirestore(initFirebase());
  const db = mongoose.connection.db;
  if (!db) throw new Error('Sin conexion a Mongo: llamar despues de connectDatabase()');

  logger.info({ db: mongoose.connection.name, aplicar, only }, 'Inicio de migracion');

  const plans = soloDerivados
    ? []
    : only.length > 0
      ? PLANS.filter((plan) => only.includes(plan.target))
      : PLANS;

  if (plans.length === 0 && !soloDerivados) {
    throw new Error(`only no coincide con ninguna coleccion: ${only.join(', ')}`);
  }

  const colecciones: MigrationResult[] = [];
  for (const plan of plans) {
    avisar({ tipo: 'coleccion:inicio', target: plan.target });
    const result = await migrateCollection(db, firestore, plan, aplicar);
    colecciones.push(result);
    avisar({
      tipo: 'coleccion:fin',
      target: plan.target,
      leidos: result.read,
      escritos: result.upserted + result.modified,
    });
    logger.info(result, 'coleccion migrada');
  }


  const shouldDerive = soloDerivados || only.length === 0 || only.includes('orders');
  const wanted = (target: DeriveTarget): boolean =>
    shouldDerive && (derives.length === 0 || derives.includes(target));

  let items = 0;
  let currencies = 0;
  let categories = 0;
  if (wanted('items')) items = await deriveOrderItems(db, aplicar);
  if (wanted('currencies')) currencies = await deriveCurrencies(db, aplicar);
  if (wanted('categories')) categories = await deriveCategories(db, aplicar);
  const derivados = { items, currencies, categories };
  avisar({ tipo: 'derivados', derivados });

  const resumen: MigracionResumen = {
    aplicar,
    colecciones,
    derivados,
    documentosLeidos: colecciones.reduce((suma, item) => suma + item.read, 0),
    documentosEscritos: colecciones.reduce((suma, item) => suma + item.upserted + item.modified, 0),
    duracionMs: Date.now() - inicio,
  };

  logger.info(resumen, 'Migracion Firestore -> MongoDB finalizada');
  avisar({ tipo: 'fin' });
  return resumen;
};


