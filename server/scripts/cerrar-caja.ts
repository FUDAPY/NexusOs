/**
 * Cierre de caja de una sucursal desde la linea de comandos.
 *
 * POR QUE EXISTE
 * El panel (dashboard.html) todavia llama a la Cloud Function de Firebase
 * `forzarCierreCajaSucursal`, y esa via ya no funciona: no hay sesion de
 * Firebase, asi que Firestore responde permission-denied. El endpoint
 * equivalente SI existe en la API (POST /cash-shifts/forzar-cierre), pero
 * ninguna pantalla lo llama todavia.
 *
 * Mientras se conecta la UI, este script permite cerrar un turno que quedo
 * abierto SIN depender del POS: recalcula los totales desde las ordenes del
 * turno, crea el cierre, marca los tickets como arqueados y deja auditoria.
 * Usa la MISMA funcion que la API (forzarCierreSucursal), no una copia: si un
 * dia se corrige la formula, se corrige para los dos lados.
 *
 * USO
 *   npm run caja:cerrar -- --listar
 *
 *   npm run caja:cerrar -- --sucursal "Mi Sucursal" --motivo "el cajero no pudo cerrar" \
 *       --efectivo 1200000 --tarjeta 300000 --transferencia 50000 --fondo-inicial 200000
 *
 *   (agregar --confirmar para que escriba de verdad)
 *
 * Por defecto SIMULA: sin `--confirmar` no escribe absolutamente nada.
 *
 * REQUISITO: la conexion tiene que ser a un replica set. El cierre toca tres
 * colecciones en UNA transaccion (orders, cash_closes, cash_shifts).
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { CashShift, Order } from '../src/models/index.js';
import { forzarCierreSucursal } from '../src/services/cashForzado.service.js';
import {
  agruparCierreForzado,
  esCandidatoCierreForzado,
  fechaKey,
  type VentaCruda,
} from '../src/utils/cashFlow.js';

const args = process.argv.slice(2);
const bandera = (nombre: string): boolean => args.includes(`--${nombre}`);

const valor = (nombre: string): string => {
  const i = args.indexOf(`--${nombre}`);
  const v = i >= 0 ? args[i + 1] : undefined;
  return v === undefined || v.startsWith('--') ? '' : String(v);
};

const numero = (nombre: string): number => {
  const n = Number(valor(nombre));
  return Number.isFinite(n) ? n : 0;
};

const plata = (n: number): string => n.toLocaleString('es-PY');

/**
 * Tickets que un cierre forzado tomaria de esa sucursal.
 * Se aplica el MISMO filtro que el servicio (esCandidatoCierreForzado) para que
 * el preview coincida exactamente con lo que se va a cerrar.
 */
const pendientesDe = async (sucursal: string) => {
  const docs = await Order.find({ sucursal, arqueado: { $ne: true } }).limit(5000).lean().exec();
  const ventas = docs.map((d) => ({ id: String(d._id), venta: d as unknown as VentaCruda }));
  return {
    candidatas: ventas.filter((v) => esCandidatoCierreForzado(v.venta, sucursal)),
    grupo: agruparCierreForzado(ventas, sucursal),
  };
};

const listar = async (): Promise<void> => {
  const turnos = await CashShift.find({ estadoTurno: 'abierto' }).sort({ sucursal: 1 }).lean().exec();

  if (turnos.length === 0) {
    console.log('No hay turnos abiertos.');
    return;
  }

  console.log(`Turnos ABIERTOS: ${turnos.length}\n`);

  for (const turno of turnos) {
    const { candidatas, grupo } = await pendientesDe(turno.sucursal);
    const fechas = (grupo?.ventas ?? []).map((v) => v.fecha).sort((a, b) => a.getTime() - b.getTime());
    const ultima = fechas[fechas.length - 1];

    console.log(`- ${turno.sucursal}`);
    console.log(`    turnoId:             ${turno.turnoId}`);
    console.log(`    abierto desde:       ${turno.fechaApertura ? fechaKey(turno.fechaApertura) : '(sin fecha)'}`);
    console.log(`    tickets sin arquear: ${candidatas.length}`);
    if (grupo) {
      console.log(
        `    cerraria el turno:   ${grupo.turnoId} (${grupo.ventas.length} tickets, ` +
          `${fechas[0] ? fechaKey(fechas[0]) : '?'} -> ${ultima ? fechaKey(ultima) : '?'})`,
      );
      if (grupo.ventas.length !== candidatas.length) {
        console.log(`    OJO: hay ${candidatas.length - grupo.ventas.length} ticket(s) de OTRO turno sin arquear.`);
        console.log('         El cierre forzado toma el turno con actividad mas reciente y NO los incluye.');
      }
    } else {
      console.log('    (no hay tickets que un cierre forzado pueda tomar)');
    }
    console.log('');
  }

  console.log('Para cerrar uno: npm run caja:cerrar -- --sucursal "<nombre>" --motivo "..." --efectivo N ...');
};

const cerrar = async (): Promise<void> => {
  const sucursal = valor('sucursal').trim();
  const motivo = valor('motivo').trim();
  const confirmar = bandera('confirmar');

  if (sucursal === '') {
    console.error('Falta --sucursal. Corra primero: npm run caja:cerrar -- --listar');
    process.exitCode = 1;
    return;
  }
  if (motivo === '') {
    console.error('Falta --motivo (queda en la auditoria del cierre).');
    process.exitCode = 1;
    return;
  }

  const declaracion = {
    fondoInicial: numero('fondo-inicial'),
    efectivo: numero('efectivo'),
    tarjeta: numero('tarjeta'),
    transferencia: numero('transferencia'),
    gastos: numero('gastos'),
  };

  console.log(confirmar ? '*** CIERRE REAL ***' : '--- SIMULACION (agregue --confirmar para ejecutar) ---');
  console.log(`sucursal:  ${sucursal}`);
  console.log(`motivo:    ${motivo}`);
  console.log(
    `declarado: efectivo ${plata(declaracion.efectivo)} | tarjeta ${plata(declaracion.tarjeta)} | ` +
      `transferencia ${plata(declaracion.transferencia)} | gastos ${plata(declaracion.gastos)} | ` +
      `fondo ${plata(declaracion.fondoInicial)}\n`,
  );

  const r = await forzarCierreSucursal(
    { sucursal, motivo, declaracion, dryRun: !confirmar },
    { ip: 'script', userAgent: 'scripts/cerrar-caja.ts' },
  );

  console.log(`turno:             ${r.turnoId}`);
  console.log(`abierto desde:     ${fechaKey(r.fechaApertura)}`);
  console.log(`tickets contados:  ${r.tickets}`);
  console.log(
    `sistema esperado:  efectivo ${plata(r.totals.efectivo)} | tarjeta ${plata(r.totals.tarjeta)} | ` +
      `transferencia ${plata(r.totals.transferencia)} | credito ${plata(r.totals.credito)}`,
  );
  console.log(`TOTAL ESPERADO:    ${plata(r.totalEsperado)}`);
  console.log(`TOTAL DECLARADO:   ${plata(r.totalDeclarado)}`);
  console.log(`DIFERENCIA:        ${plata(r.difference)}${r.difference === 0 ? '  (cuadra)' : ''}`);
  console.log(`total vendido:     ${plata(r.totalVendido)}`);
  console.log(r.cierreId ? `cierreId:          ${r.cierreId}` : '\nNo se escribio nada (simulacion).');
};

const main = async (): Promise<void> => {
  await mongoose.connect(env.MONGO_URI);

  try {
    if (bandera('listar') || valor('sucursal') === '') {
      await listar();
      return;
    }
    await cerrar();
  } finally {
    await mongoose.disconnect();
  }
};

void main().catch((error: unknown) => {
  console.error('Fallo el cierre:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
