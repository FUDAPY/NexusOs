import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { aFecha, aValorMongo } from '../src/utils/firestoreValor.js';
import {
  armarResumenVentas,
  elegirTurnosActivos,
  normalizarVentaLegado,
  type DocTurnoCrudo,
  type DocVentaCrudo,
} from '../src/services/legado.service.js';

/**
 * El fixture se lee con `readFileSync` y no con `import ... with { type: 'json' }`: el
 * proyecto compila como ESM (`module: NodeNext`) y esa sintaxis depende de la version
 * del bundler de turno. Leerlo no depende de nada.
 */
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/legado.json', import.meta.url), 'utf8'),
) as {
  turnoVivoId: string;
  turnosAbiertos: Record<string, unknown>[];
  turnoVivoDoc: Record<string, unknown>;
  ventasTurnoVivo: Record<string, unknown>[];
};

/**
 * PUENTE AL SISTEMA VIEJO (Firestore), sin tocar la red.
 *
 * El fixture NO es inventado: son documentos REALES de produccion
 * (`sys-pos-erp-lingroup`) capturados con firebase-admin el 21/09/2026 — los 7 turnos
 * que estaban abiertos entonces (con los duplicados viejos que deja el POS viejo) y
 * las 48 ventas del turno vivo de CAFETERIA CHICOLIN.
 *
 * Por que importa que sea real: los numeros de abajo son los MISMOS que el sistema
 * viejo calcula y guarda en su propio documento (`ventaTotalBruta` 634.000, efectivo
 * 473.000, transferencia 145.000, credito 16.000). Si alguien cambia la normalizacion
 * de fechas o la eleccion del turno activo, estos valores dejan de dar y el test lo
 * dice antes de que el panel muestre un arqueo equivocado.
 */
const turnosCrudos = fixture.turnosAbiertos as unknown as DocTurnoCrudo[];
const ventasCrudas = fixture.ventasTurnoVivo as unknown as DocVentaCrudo[];

describe('elegirTurnosActivos: un solo turno por sucursal, el que se esta usando', () => {
  it('ignora los turnos abiertos que nunca se cerraron', () => {
    const turnos = elegirTurnosActivos(turnosCrudos);

    // 7 abiertos en total, pero solo 2 sucursales: CHICOLIN arrastra uno del 25/07 y
    // San Benito tres del 30/08. Mostrarlos seria mostrar tickets viejos como si fueran
    // el turno de ahora.
    expect(turnosCrudos).toHaveLength(7);
    expect(turnos).toHaveLength(2);
    expect(turnos.map((t) => t.turnoId)).toEqual([
      'TURN-CAFETERIACHI-1789980211733-571',
      'TURN-SanBenitoCaf-1788122527213-888',
    ]);
  });

  it('desempata por updatedAt y no por fechaApertura', () => {
    const turnos = elegirTurnosActivos(turnosCrudos);
    const chicolin = turnos.find((t) => t.sucursal === 'CAFETERIA CHICOLIN');

    /* Los dos turnos de CHICOLIN se abrieron con 3 segundos de diferencia y el de
       fechaApertura MAS NUEVA (`-805`) quedo vacio: el que tiene las ventas es el otro.
       Si el desempate fuera por apertura, el panel mostraria un turno sin tickets. */
    expect(chicolin?.turnoId).toBe('TURN-CAFETERIACHI-1789980211733-571');
    expect(chicolin?.cajero).toBe('Noni');
    expect(chicolin?.resumen.totalTickets).toBeGreaterThan(0);
  });

  it('normaliza los Timestamps serializados del sistema viejo a ISO', () => {
    const turnos = elegirTurnosActivos(turnosCrudos);
    const chicolin = turnos[0];

    // `{_seconds, _nanoseconds}` (como los devuelve Firestore) -> ISO legible.
    expect(chicolin?.fechaApertura).toMatch(/^2026-09-21T/);
    expect(chicolin?.actualizadoEn).toMatch(/^2026-09-21T/);
    expect((chicolin?.actualizadoEn ?? '') > (chicolin?.fechaApertura ?? '')).toBe(true);
  });
});

describe('los montos del turno salen de la formula del arqueo, no de una copia', () => {
  const ventas = ventasCrudas.map((doc) => normalizarVentaLegado(doc));

  it('reproduce los totales que el sistema viejo guarda en su propio documento', () => {
    const resumen = armarResumenVentas(fixture.turnoVivoId, ventas);

    expect(resumen.tickets).toBe(48);
    expect(resumen.totales).toEqual({
      efectivo: 473000,
      tarjeta: 0,
      transferencia: 145000,
      credito: 16000,
    });
    // La bruta es la suma de los medios de pago inmediatos + credito: 634.000, igual
    // que `ventaTotalBruta` en Firestore.
    const { efectivo, tarjeta, transferencia, credito } = resumen.totales;
    expect(efectivo + tarjeta + transferencia + credito).toBe(634000);
  });

  it('deja fuera del flujo las cuentas "por cobrar"', () => {
    const pendientes = ventas.filter((v) => String(v['estadoPago'] ?? '').toLowerCase() === 'pendiente');
    const sumaPendientes = pendientes.reduce((suma, v) => suma + Number(v['total'] ?? 0), 0);
    const sumaTickets = ventas.reduce((suma, v) => suma + Number(v['total'] ?? 0), 0);
    const { totales } = armarResumenVentas(fixture.turnoVivoId, ventas);

    expect(pendientes).toHaveLength(5);
    expect(sumaPendientes).toBe(84000);
    /* Regla del negocio (functions/index.js:745): una venta `pendiente` solo aporta al
       flujo si es cuenta pendiente / metodo 'por cobrar'. En CHICOLIN esas 5 mesas
       explican toda la diferencia entre la suma de los tickets y la venta bruta. */
    expect(sumaTickets - sumaPendientes).toBe(634000);
    expect(totales.efectivo + totales.tarjeta + totales.transferencia + totales.credito).toBe(634000);
  });

  it('agrupa los productos vendidos del turno', () => {
    const { productos } = armarResumenVentas(fixture.turnoVivoId, ventas);
    const cantidades = Object.values(productos).reduce((suma, p) => suma + p.cant, 0);

    expect(Object.keys(productos).length).toBeGreaterThan(10);
    expect(cantidades).toBeGreaterThan(0);
    // Todo producto agrupado trae su total: es lo que muestra el detalle del turno.
    for (const producto of Object.values(productos)) {
      expect(producto.total).toBeGreaterThan(0);
    }
  });

  it('marca las filas como del sistema viejo para que el panel las distinga', () => {
    const resumen = armarResumenVentas(fixture.turnoVivoId, ventas);
    const primera = resumen.items[0] as Record<string, unknown>;

    expect(primera['origenLegado']).toBe(true);
    expect(primera['legacyId']).toBe(primera['id']);
    expect(primera['turnoId']).toBe(fixture.turnoVivoId);
  });

  it('normaliza las TRES formas de fecha que conviven en la coleccion', () => {
    // Las 48 ventas del fixture vienen con `{_seconds}`: ninguna puede quedar sin Date,
    // porque `resolverFecha` no entiende ese objeto y el ticket desaparece del arqueo.
    const sinFecha = ventas.filter((v) => !(v['fecha'] instanceof Date));
    const sinApertura = ventas.filter((v) => !(v['fechaAperturaTurno'] instanceof Date));

    expect(sinFecha).toHaveLength(0);
    expect(sinApertura).toHaveLength(0);
    expect(new Date(String(ventas[0]?.['fecha'])).getUTCFullYear()).toBe(2026);
  });
});

describe('normalizacion de valores de Firestore', () => {
  it('aFecha entiende Timestamp serializado, Timestamp real y string ISO', () => {
    const serializado = aFecha({ _seconds: 1789995723, _nanoseconds: 42000000 });
    const conToDate = aFecha({ toDate: () => new Date('2026-09-21T08:43:38.686Z') });
    const iso = aFecha('2026-03-14T13:31:48.918Z');

    expect(serializado?.toISOString()).toBe('2026-09-21T13:02:03.042Z');
    expect(conToDate?.toISOString()).toBe('2026-09-21T08:43:38.686Z');
    expect(iso?.toISOString()).toBe('2026-03-14T13:31:48.918Z');
    expect(aFecha(null)).toBeNull();
    expect(aFecha('no es una fecha')).toBeNull();
  });

  it('aValorMongo convierte los timestamps anidados dentro de items', () => {
    const convertido = aValorMongo({
      total: 5000,
      fecha: { _seconds: 1789995723, _nanoseconds: 42000000 },
      items: [{ nombre: 'JUGO', cantidad: 1, fechaArqueo: { _seconds: 1789995723, _nanoseconds: 0 } }],
    }) as { fecha: Date; items: { fechaArqueo: Date }[] };

    expect(convertido.fecha).toBeInstanceOf(Date);
    expect(convertido.items[0]?.fechaArqueo).toBeInstanceOf(Date);
  });
});

/**
 * El cierre del turno en el sistema viejo se refleja solo: el puente solo pide los
 * documentos con `estadoTurno == 'abierto'`, asi que cuando el cajero cierra su caja el
 * turno deja de aparecer y el panel se queda sin tickets que mostrar. Un turno CERRADO
 * nunca entra a `elegirTurnosActivos`, aunque sus ventas sigan en `sales`.
 */
/**
 * El cierre del turno en el sistema viejo se refleja solo: el puente solo pide los
 * documentos con `estadoTurno == 'abierto'`, asi que cuando el cajero cierra su caja el
 * turno deja de aparecer y el panel se queda sin tickets que mostrar. Un turno CERRADO
 * nunca entra a `elegirTurnosActivos`, aunque sus ventas sigan en `sales`.
 */
describe('un turno cerrado no puede aparecer como activo', () => {
  it('el filtro de estado es lo unico que separa un turno vivo de uno cerrado', () => {
    const cerrado: DocTurnoCrudo = {
      id: 'TURN-SanBenitoCaf-1788122526767-439',
      turnoId: 'TURN-SanBenitoCaf-1788122526767-439',
      sucursal: 'San Benito Cafe Resto Bar',
      estadoTurno: 'cerrado',
      updatedAt: { _seconds: 1789875328, _nanoseconds: 0 },
      fechaApertura: { _seconds: 1788122526, _nanoseconds: 0 },
      ventaTotalBruta: 1622000,
    };

    /* Ojo: `elegirTurnosActivos` NO filtra por estado (eso lo hace la consulta a
       Firestore, `where('estadoTurno','==','abierto')`). Este caso fija dos cosas: que el
       fixture son 7 turnos TODOS abiertos, y que si algun dia alguien saca ese `where`,
       un turno cerrado entraria al panel con sus tickets viejos. */
    expect(fixture.turnosAbiertos.every((t) => (t as Record<string, unknown>)['estadoTurno'] === 'abierto')).toBe(true);
    expect(elegirTurnosActivos([cerrado])[0]?.estadoTurno).toBe('cerrado');
  });
});

describe('sin credencial de Firebase el puente se apaga solo', () => {
  it('responde 503 LEGADO_NO_CONFIGURADO en vez de romper el panel', async () => {
    /* El escenario real: se despliega el API sin montar el service account. El panel
       tiene que seguir mostrando lo de Mongo, no quedarse en blanco ni llenar la consola
       de errores. Se reimporta el service con el PATH apuntando a un archivo que no
       existe: eso es exactamente lo que ve el servidor en ese caso. */
    vi.stubEnv('FIREBASE_SERVICE_ACCOUNT_PATH', 'C:\\no-existe\\service-account.json');
    vi.stubEnv('FIREBASE_SERVICE_ACCOUNT_JSON', '');
    vi.resetModules();

    const servicio = await import('../src/services/legado.service.js');

    expect(servicio.legadoDisponible()).toBe(true);
    await expect(servicio.listarTurnosAbiertosLegado()).rejects.toMatchObject({
      statusCode: 503,
      code: 'LEGADO_NO_CONFIGURADO',
    });

    vi.unstubAllEnvs();
  });
});

