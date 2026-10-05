import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * Renovacion silenciosa del JWT.
 *
 * El navegador limita setTimeout a 2^31-1 ms (unos 24,8 dias) y cualquier
 * espera mayor la dispara de inmediato. Con un JWT largo eso convertia la
 * renovacion en una llamada seguida a /auth/refresh, y un fallo dejaba el
 * temporizador caido, asi que la sesion se cortaba al vencimiento igual.
 *
 * Se carga el script real en un sandbox en vez de reimplementarlo, para que
 * el test falle si alguien toca la logica de programacion.
 */
const FUENTE = readFileSync(new URL('../../frontend/nexus-auth.js', import.meta.url), 'utf8');

const TOPE_SET_TIMEOUT = 2147483647; // 2^31 - 1, el maximo que acepta el navegador
const ESPERA_MAXIMA_MS = 24 * 24 * 60 * 60 * 1000;
const REINTENTO_TRAS_FALLO_MS = 5 * 60 * 1000;
const RENOVAR_ANTES_DE_MS = 5 * 60 * 1000;

type Timer = { id: number; fn: () => void; delay: number };

function jwtConExpiracion(expEnSegundos: number): string {
  const carga = Buffer.from(JSON.stringify({ sub: 'uid-test', exp: expEnSegundos })).toString('base64');
  return `eyJhbGciOiJIUzI1NiJ9.${carga}.firma`;
}

type Entorno = {
  almacen: Map<string, string>;
  oyentes: Map<string, Array<() => void>>;
  api: { token: string | null; post: () => Promise<{ data: unknown }> };
  readonly timers: Timer[];
  cargar: () => void;
  leerToken: () => string | null;
  autenticar: (expEnSegundos: number) => void;
  descartarTimers: () => void;
  disparar: () => Promise<void>;
  dispararOyente: (tipo: string) => Promise<void>;
};

function crearEntorno(): Entorno {
  const almacen = new Map<string, string>();
  const oyentes = new Map<string, Array<() => void>>();
  let timers: Timer[] = [];
  let idSiguiente = 1;

  const sandbox: Record<string, unknown> = {
    Date,
    JSON,
    Math,
    String,
    Number,
    Object,
    Promise,
    isFinite,
    console,
    atob: (texto: string) => Buffer.from(texto, 'base64').toString('binary'),
    setTimeout: (fn: () => void, delay?: number) => {
      const id = idSiguiente++;
      timers.push({ id, fn, delay: Number(delay) || 0 });
      return id;
    },
    clearTimeout: (id: number) => {
      timers = timers.filter((t) => t.id !== id);
    },
    localStorage: {
      getItem: (clave: string) => (almacen.has(clave) ? almacen.get(clave) : null),
      setItem: (clave: string, valor: string) => void almacen.set(clave, String(valor)),
      removeItem: (clave: string) => void almacen.delete(clave),
    },
    document: {
      hidden: false,
      addEventListener: (tipo: string, fn: () => void) => {
        const lista = oyentes.get(tipo) ?? [];
        lista.push(fn);
        oyentes.set(tipo, lista);
      },
    },
    addEventListener: (tipo: string, fn: () => void) => {
      const lista = oyentes.get(tipo) ?? [];
      lista.push(fn);
      oyentes.set(tipo, lista);
    },
    NexusAPI: {
      token: null as string | null,
      post: (): Promise<{ data: unknown }> => Promise.resolve({ data: null }),
    },
  };
  sandbox.window = sandbox;

  const contexto = vm.createContext(sandbox);
  const esperar = (): Promise<void> => new Promise<void>((resolver) => setImmediate(resolver));

  return {
    almacen,
    oyentes,
    api: sandbox.NexusAPI as { token: string | null; post: () => Promise<{ data: unknown }> },
    get timers() {
      return timers;
    },
    cargar: () => vm.runInContext(FUENTE, contexto),
    leerToken: () => almacen.get('__pos_token') ?? null,
    /** Deja la sesion completa: sin __pos_session, autenticado() da false y
        la renovacion no se programa nunca. */
    autenticar: (expEnSegundos: number) => {
      almacen.set(
        '__pos_session',
        JSON.stringify({ uid: 'uid-test', email: 'test@nexus.local', nombre: 'Test', rol: 'admin', sucursal: 'Centro' }),
      );
      almacen.set('__pos_token', jwtConExpiracion(expEnSegundos));
    },
    /** Simula que el navegador suspendio los timers en segundo plano. */
    descartarTimers: () => {
      timers = [];
    },
    /** Ejecuta los timers pendientes y descansa hasta que se asienten las promesas. */
    disparar: async () => {
      const pendientes = timers;
      timers = [];
      for (const timer of pendientes) timer.fn();
      await esperar();
      await esperar();
      await esperar();
    },
    dispararOyente: async (tipo: string) => {
      for (const oyente of oyentes.get(tipo) ?? []) oyente();
      await esperar();
    },
  };
}

describe('renovacion del JWT en el front', () => {
  it('programa dentro del limite de setTimeout con un token de 30 dias', () => {
    const entorno = crearEntorno();
    entorno.autenticar(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60);
    entorno.cargar();

    expect(entorno.timers).toHaveLength(1);
    expect(entorno.timers[0]!.delay).toBeLessThanOrEqual(TOPE_SET_TIMEOUT);
    /* Sin este tope la espera seria 30d - 5min = 2.591.700.000 ms, por encima del
       maximo: el navegador la dispararia al instante y entraria en bucle. */
    expect(entorno.timers[0]!.delay).toBe(ESPERA_MAXIMA_MS);
  });

  it('programa el momento exacto con un token de 12 h', () => {
    const entorno = crearEntorno();
    entorno.autenticar(Math.floor(Date.now() / 1000) + 12 * 60 * 60);
    entorno.cargar();

    expect(entorno.timers).toHaveLength(1);
    expect(entorno.timers[0]!.delay).toBeCloseTo(12 * 60 * 60 * 1000 - RENOVAR_ANTES_DE_MS, -3);
  });

  it('guarda el token nuevo y reprograma cuando la renovacion sale bien', async () => {
    const entorno = crearEntorno();
    const nuevo = jwtConExpiracion(Math.floor(Date.now() / 1000) + 13 * 60 * 60);
    entorno.autenticar(Math.floor(Date.now() / 1000) + 12 * 60 * 60);
    entorno.cargar();
    entorno.api.post = () => Promise.resolve({ data: { token: nuevo } });

    await entorno.disparar();

    expect(entorno.leerToken()).toBe(nuevo);
    expect(entorno.api.token).toBe(nuevo);
    expect(entorno.timers).toHaveLength(1);
  });

  it('reprograma el reintento si falla la red en vez de dejar el temporizador caido', async () => {
    const entorno = crearEntorno();
    entorno.autenticar(Math.floor(Date.now() / 1000) + 12 * 60 * 60);
    entorno.cargar();
    entorno.api.post = () => Promise.reject(new Error('red caida'));

    await entorno.disparar();

    /* Antes el .catch devolvia null sin reprogramar: la sesion moria al vencer. */
    expect(entorno.timers).toHaveLength(1);
    expect(entorno.timers[0]!.delay).toBe(REINTENTO_TRAS_FALLO_MS);
    expect(entorno.leerToken()).not.toBeNull();
  });

  it('deja de reintentar cuando el token ya vencio', async () => {
    const entorno = crearEntorno();
    entorno.autenticar(Math.floor(Date.now() / 1000) - 60);
    entorno.cargar();
    entorno.api.post = () => Promise.reject(new Error('401'));

    await entorno.disparar();

    expect(entorno.timers).toHaveLength(0);
  });

  it('vuelve a programar al volver la pestana a ser visible', async () => {
    const entorno = crearEntorno();
    entorno.autenticar(Math.floor(Date.now() / 1000) + 12 * 60 * 60);
    entorno.cargar();
    /* Simula el equipo durmiendo: el temporizador se pierde. */
    entorno.descartarTimers();
    expect(entorno.timers).toHaveLength(0);

    await entorno.dispararOyente('visibilitychange');

    expect(entorno.timers).toHaveLength(1);
  });
});
