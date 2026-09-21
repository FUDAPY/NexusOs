import { readFileSync } from 'node:fs';
import { initializeApp, cert, applicationDefault, type App, type ServiceAccount } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../utils/response.js';
import {
  agruparProductos,
  claveDoc,
  sumarAportes,
  texto,
  type TotalesCierre,
  type VentaCruda,
} from '../utils/cashFlow.js';
import { aValorMongo } from '../utils/firestoreValor.js';

/**
 * PUENTE DE LECTURA AL SISTEMA VIEJO (Firestore).
 *
 * POR QUE EXISTE
 * Los cajeros siguen vendiendo en el sistema viejo mientras se construye el nuevo, y
 * esas ventas NO estan en Mongo: viven en `sales` / `cashFlows` de Firestore. El panel
 * lee Mongo, asi que no las veia: habia que recargar la pagina para ver algo que
 * tampoco llegaba.
 *
 * POR QUE LO LEE EL SERVIDOR Y NO EL NAVEGADOR
 * Las reglas de Firestore no autorizan la lectura desde el cliente (era el
 * "Missing or insufficient permissions" de la consola). Con el service account el
 * servidor si puede, y la credencial no llega nunca al navegador.
 *
 * ES DE SOLO LECTURA. No escribe ni en Firestore ni en Mongo: el sistema viejo sigue
 * siendo el dueno de sus datos hasta que el POS nuevo lo reemplace.
 *
 * LAS CUENTAS LAS HACE EL CODIGO YA PORTADO
 * Los documentos de `sales` conservan los mismos nombres de campo que `orders`, asi que
 * los totales se calculan con `sumarAportes()` y `agruparProductos()` —los helpers
 * portados de las Cloud Functions— en vez de reimplementar la formula aca. Verificado
 * contra produccion: el turno vivo de CHICOLIN dio exactamente los mismos numeros que
 * el resumen que el propio sistema viejo guarda en su documento (`ventaTotalBruta`
 * 629.000, efectivo 468.000, transferencia 145.000, credito 16.000).
 */

/** Tope de tickets por turno. El mismo que usa el cierre forzado. */
const MAX_TICKETS = 5000;

/**
 * TTL de la cache.
 *
 * El dashboard refresca cada pocos segundos y puede haber varios abiertos: sin cache,
 * cada refresco seria una lectura de Firestore por panel. Con estos valores, N paneles
 * mirando el mismo turno comparten una sola lectura.
 */
const TTL_TURNOS_MS = 3_000;
const TTL_VENTAS_MS = 4_000;

export interface ResumenTurnoLegado {
  ventaTotalBruta: number;
  efectivo: number;
  tarjetaPOS: number;
  transferencia: number;
  credito: number;
  totalTickets: number;
  totalTicketsFlujo: number;
  totalTicketsPagados: number;
  totalTicketsPendientes: number;
  totalProductos: number;
}

export interface TurnoLegado {
  turnoId: string;
  sucursal: string;
  sucursalId: string;
  cajero: string;
  fondoInicial: number;
  estadoTurno: string;
  /** ISO: la fecha del sistema viejo, ya normalizada (Timestamp / {_seconds} / string). */
  fechaApertura: string;
  /** ISO. Es lo que se usa para elegir el turno activo entre los duplicados. */
  actualizadoEn: string;
  resumen: ResumenTurnoLegado;
}

export interface VentasTurnoLegado {
  turnoId: string;
  tickets: number;
  items: VentaCruda[];
  totales: TotalesCierre;
  productos: Record<string, { cant: number; total: number }>;
}

/* ------------------------------------------------------------------ */
/* Conexion (perezosa) a Firestore                                     */
/* ------------------------------------------------------------------ */

const APP_LEGADO = 'pos-legado';

let firestore: Firestore | null = null;
let falloInicializacion: string | null = null;

const rutaServiceAccount = (): string => (env.FIREBASE_SERVICE_ACCOUNT_PATH ?? '').trim();
const jsonServiceAccount = (): string => (env.FIREBASE_SERVICE_ACCOUNT_JSON ?? '').trim();

/** `true` si hay con que autenticarse contra Firestore. */
export const legadoDisponible = (): boolean =>
  rutaServiceAccount().length > 0 || jsonServiceAccount().length > 0 || Boolean(env.FIREBASE_PROJECT_ID);

const proyectoDeArchivo = (ruta: string): string | undefined => {
  try {
    const raw = JSON.parse(readFileSync(ruta, 'utf8')) as { project_id?: string };
    return raw['project_id'];
  } catch {
    /* El error real de lectura lo reporta `cert()`; aca solo se intenta sacar el project_id. */
    return undefined;
  }
};

const inicializar = (): App => {
  const ruta = rutaServiceAccount();
  const json = jsonServiceAccount();

  if (ruta.length > 0) {
    return initializeApp(
      { credential: cert(ruta), projectId: env.FIREBASE_PROJECT_ID ?? proyectoDeArchivo(ruta) },
      APP_LEGADO,
    );
  }

  if (json.length > 0) {
    const credenciales = JSON.parse(json) as ServiceAccount;
    return initializeApp(
      { credential: cert(credenciales), projectId: env.FIREBASE_PROJECT_ID ?? credenciales.projectId },
      APP_LEGADO,
    );
  }

  /* Ultimo recurso: credenciales por defecto del entorno (Cloud Run / GCE). En un VPS
     no existen, asi que la via normal en produccion es PATH o JSON. */
  return initializeApp({ credential: applicationDefault(), projectId: env.FIREBASE_PROJECT_ID }, APP_LEGADO);
};

/**
 * Devuelve el Firestore del sistema viejo, inicializando en la primera llamada.
 *
 * El fallo se RECUERDA (`falloInicializacion`) para no reintentar en cada request ni
 * llenar el log: si la credencial esta mal, esta mal hasta que se corrija la
 * configuracion y se reinicie.
 */
const obtenerFirestore = (): Firestore => {
  if (firestore) return firestore;

  if (falloInicializacion !== null) {
    throw new AppError(
      `El puente al sistema viejo no esta configurado: ${falloInicializacion}`,
      503,
      'LEGADO_NO_CONFIGURADO',
    );
  }

  try {
    firestore = getFirestore(inicializar());
    logger.info(
      { proyecto: env.FIREBASE_PROJECT_ID ?? null, sales: env.FIREBASE_SALES_PATH },
      'Puente al sistema viejo (Firestore) inicializado',
    );
    return firestore;
  } catch (error) {
    falloInicializacion = error instanceof Error ? error.message : String(error);
    logger.error({ err: error }, 'No se pudo inicializar el puente al sistema viejo');
    throw new AppError(
      `El puente al sistema viejo no esta configurado: ${falloInicializacion}`,
      503,
      'LEGADO_NO_CONFIGURADO',
    );
  }
};

/* ------------------------------------------------------------------ */
/* Cache en memoria                                                    */
/* ------------------------------------------------------------------ */

interface EntradaCache<T> {
  expira: number;
  valor: T;
}

const cacheTurnos: { entrada: EntradaCache<TurnoLegado[]> | null } = { entrada: null };
const cacheVentas = new Map<string, EntradaCache<VentasTurnoLegado>>();

const leerCache = <T>(entrada: EntradaCache<T> | null | undefined): T | null =>
  entrada && entrada.expira > Date.now() ? entrada.valor : null;

/** Solo para los tests: deja la cache limpia entre casos. */
export const limpiarCacheLegado = (): void => {
  cacheTurnos.entrada = null;
  cacheVentas.clear();
};

/* ------------------------------------------------------------------ */
/* Parte pura: normalizacion y eleccion del turno activo               */
/* ------------------------------------------------------------------ */

const aIso = (valor: unknown): string => {
  const fecha = aValorMongo(valor);
  return fecha instanceof Date && !Number.isNaN(fecha.getTime()) ? fecha.toISOString() : '';
};

const aNumeroSeguro = (valor: unknown): number => {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
};

/** Documento crudo de `cashFlows` tal como lo devuelve Firestore. */
export interface DocTurnoCrudo {
  id: string;
  [campo: string]: unknown;
}

const normalizarTurno = (doc: DocTurnoCrudo): TurnoLegado => {
  const sucursal = texto(doc['sucursal'], 120);
  return {
    turnoId: texto(doc['turnoId'], 180) || doc.id,
    sucursal,
    sucursalId: texto(doc['sucursalId'], 120) || claveDoc(sucursal),
    cajero: texto(doc['cajero'], 120),
    fondoInicial: aNumeroSeguro(doc['fondoInicial']),
    estadoTurno: texto(doc['estadoTurno'], 40),
    fechaApertura: aIso(doc['fechaApertura']),
    actualizadoEn: aIso(doc['updatedAt']) || aIso(doc['fechaApertura']),
    resumen: {
      ventaTotalBruta: aNumeroSeguro(doc['ventaTotalBruta']),
      efectivo: aNumeroSeguro(doc['efectivo']),
      tarjetaPOS: aNumeroSeguro(doc['tarjetaPOS']),
      transferencia: aNumeroSeguro(doc['transferencia']),
      credito: aNumeroSeguro(doc['credito']),
      totalTickets: aNumeroSeguro(doc['totalTickets']),
      totalTicketsFlujo: aNumeroSeguro(doc['totalTicketsFlujo']),
      totalTicketsPagados: aNumeroSeguro(doc['totalTicketsPagados']),
      totalTicketsPendientes: aNumeroSeguro(doc['totalTicketsPendientes']),
      totalProductos: aNumeroSeguro(doc['totalProductos']),
    },
  };
};

/**
 * De todos los turnos ABIERTOS de una sucursal devuelve el que esta en uso.
 *
 * Hace falta porque el sistema viejo deja turnos abiertos que nunca se cerraron
 * (verificado en produccion: 3 abiertos en CAFETERIA CHICOLIN, uno del 25 de julio;
 * 4 en San Benito, dos del 30 de agosto). Mostrarlos todos seria mostrar tickets
 * viejos como si fueran el turno de ahora.
 *
 * El desempate es `actualizadoEn` (el `updatedAt` del documento, que el POS viejo
 * reescribe con cada venta) y NO `fechaApertura`: el 21/09 CHICOLIN abrio dos turnos
 * con 3 segundos de diferencia y el de `fechaApertura` mas nueva (`-805`) quedo vacio;
 * el que tiene los 47 tickets es el anterior, y su `updatedAt` lo delata.
 */
export const elegirTurnosActivos = (docs: DocTurnoCrudo[]): TurnoLegado[] => {
  const porSucursal = new Map<string, TurnoLegado>();

  for (const doc of docs) {
    const turno = normalizarTurno(doc);
    if (turno.turnoId === '') continue;

    const clave = turno.sucursalId || turno.sucursal || turno.turnoId;
    const actual = porSucursal.get(clave);
    if (!actual || turno.actualizadoEn > actual.actualizadoEn) porSucursal.set(clave, turno);
  }

  return [...porSucursal.values()].sort((a, b) => b.actualizadoEn.localeCompare(a.actualizadoEn));
};

/** Documento crudo de `sales`. */
export interface DocVentaCrudo {
  id: string;
  [campo: string]: unknown;
}

/**
 * Normaliza una venta del sistema viejo.
 *
 * `aValorMongo` sobre TODO el documento: los Timestamps serializados (`{_seconds}`) que
 * traen `fecha`, `fechaAperturaTurno` y `fechaArqueo` no los entiende `resolverFecha`,
 * y una fecha rota saca al ticket del arqueo sin ningun error visible.
 *
 * `origenLegado` viaja en la fila para que el panel pueda distinguir un ticket del
 * sistema viejo de uno del POS nuevo.
 */
export const normalizarVentaLegado = (doc: DocVentaCrudo): VentaCruda => ({
  ...(aValorMongo({ ...doc }) as Record<string, unknown>),
  id: doc.id,
  _id: doc.id,
  legacyId: doc.id,
  origenLegado: true,
});

/**
 * Totales y productos de un turno, con los helpers portados del sistema viejo.
 *
 * Es la razon por la que el panel no necesita sumar nada: los montos que muestra salen
 * de la misma formula que usa el arqueo del sistema viejo, no de una copia.
 */
export const armarResumenVentas = (turnoId: string, ventas: VentaCruda[]): VentasTurnoLegado => ({
  turnoId,
  tickets: ventas.length,
  items: ventas,
  totales: sumarAportes(ventas.map((venta, indice) => ({ id: String(venta['id'] ?? indice), venta }))),
  productos: agruparProductos(ventas.map((venta) => ({ venta }))),
});

/* ------------------------------------------------------------------ */
/* Lectura de Firestore                                                */
/* ------------------------------------------------------------------ */

/** Turnos abiertos en el sistema viejo, uno por sucursal (el activo). */
export const listarTurnosAbiertosLegado = async (): Promise<TurnoLegado[]> => {
  const cacheado = leerCache(cacheTurnos.entrada);
  if (cacheado) return cacheado;

  const db = obtenerFirestore();
  const snapshot = await db.collection('cashFlows').where('estadoTurno', '==', 'abierto').limit(200).get();

  const docs: DocTurnoCrudo[] = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const turnos = elegirTurnosActivos(docs);
  cacheTurnos.entrada = { expira: Date.now() + TTL_TURNOS_MS, valor: turnos };
  return turnos;
};

/**
 * Ventas de un turno del sistema viejo.
 *
 * SIN `orderBy` A PROPOSITO: Firestore exige un indice compuesto cuando se combina una
 * igualdad con un orden por otro campo, y no se puede crear un indice por cada
 * despliegue. Se filtra por `turnoId` (igualdad sola: usa el indice automatico) y se
 * ordena en memoria, que con los tickets de un turno es instantaneo.
 */
export const leerVentasTurnoLegado = async (
  turnoIdCrudo: string,
  opciones: { saltarCache?: boolean } = {},
): Promise<VentasTurnoLegado> => {
  const turnoId = texto(turnoIdCrudo, 180);
  if (turnoId === '') {
    throw new AppError('Falta el turnoId', 400, 'MISSING_TURNO_ID');
  }

  if (opciones.saltarCache !== true) {
    const cacheado = leerCache(cacheVentas.get(turnoId));
    if (cacheado) return cacheado;
  }

  const db = obtenerFirestore();
  const snapshot = await db
    .collection(env.FIREBASE_SALES_PATH)
    .where('turnoId', '==', turnoId)
    .limit(MAX_TICKETS)
    .get();

  const ventas = snapshot.docs
    .map((doc) => normalizarVentaLegado({ id: doc.id, ...doc.data() }))
    .sort((a, b) => {
      const fa = a['fecha'] instanceof Date ? a['fecha'].getTime() : 0;
      const fb = b['fecha'] instanceof Date ? b['fecha'].getTime() : 0;
      return fb - fa;
    });

  const resultado = armarResumenVentas(turnoId, ventas);
  cacheVentas.set(turnoId, { expira: Date.now() + TTL_VENTAS_MS, valor: resultado });
  return resultado;
};

/** Diagnostico: que ve el servidor del sistema viejo. Alimenta el endpoint de estado. */
export const estadoLegado = async (): Promise<{
  disponible: boolean;
  proyecto: string | null;
  salesPath: string;
  error: string | null;
  turnosAbiertos: { turnoId: string; sucursal: string; actualizadoEn: string }[];
}> => {
  const base = {
    disponible: legadoDisponible(),
    proyecto: env.FIREBASE_PROJECT_ID ?? null,
    salesPath: env.FIREBASE_SALES_PATH,
  };

  try {
    const turnos = await listarTurnosAbiertosLegado();
    return {
      ...base,
      error: null,
      turnosAbiertos: turnos.map((t) => ({
        turnoId: t.turnoId,
        sucursal: t.sucursal,
        actualizadoEn: t.actualizadoEn,
      })),
    };
  } catch (error) {
    return {
      ...base,
      error: error instanceof Error ? error.message : String(error),
      turnosAbiertos: [],
    };
  }
};
