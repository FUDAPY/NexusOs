import { AppError } from '../utils/response.js';
import { withTransaction } from '../utils/withTransaction.js';
import {
  agruparCierreForzado,
  agruparProductos,
  fechaKey,
  sumarAportes,
  texto,
  type VentaCruda,
} from '../utils/cashFlow.js';
import { AuditLog, CashClose, CashShift, Order } from '../models/index.js';
import { emitTurnoEvent } from '../sockets/kds.js';
import type { ClientSession } from 'mongoose';
import type { TotalesCierre } from '../utils/cashFlow.js';

export interface DeclaracionCaja {
  fondoInicial: number;
  efectivo: number;
  tarjeta: number;
  transferencia: number;
  gastos: number;
}

export interface ForzarCierreInput {
  sucursal: string;
  motivo: string;
  declaracion: DeclaracionCaja;
  htmlTicket?: string;
  /** Si es true, calcula y devuelve sin escribir nada. */
  dryRun?: boolean;
  forzadoPor?: string;
  forzadoPorNombre?: string;
}

export interface ForzarCierreResult {
  ok: true;
  dryRun: boolean;
  turnoId: string;
  sucursal: string;
  tickets: number;
  totals: { efectivo: number; tarjeta: number; transferencia: number; credito: number };
  totalEsperado: number;
  totalDeclarado: number;
  totalVendido: number;
  difference: number;
  fechaApertura: Date;
  cierreId?: string;
}

/** Tope de tickets a leer. Igual al del original (functions/index.js:1784). */
const MAX_TICKETS = 5000;

/**
 * Cierre forzado de una sucursal entera desde el panel administrativo.
 *
 * PORT de `forzarCierreCajaSucursal` (functions/index.js:1754-1927).
 *
 * Existe porque la caja no siempre puede cerrar desde el POS (se colgo el
 * equipo, se fue el cajero): administracion cierra el turno por ella, dejando
 * registrado el motivo y los montos declarados a mano.
 *
 * Todo va en UNA transaccion porque toca tres colecciones (orders, cash_closes,
 * cash_shifts). Si los tickets quedaran arqueados y el cierre no se guardara, el
 * turno desapareceria del sistema sin arqueo: plata sin registrar.
 *
 * La formula de "esperado" es la del original y NO se debe cambiar sin hablarlo:
 *   esperadoEfectivo = fondoInicial + ventasEfectivo - gastos
 *   esperado         = esperadoEfectivo + tarjeta + transferencia
 * (el credito se informa pero no se espera en caja, porque no entro plata).
 */
export const forzarCierreSucursal = async (
  input: ForzarCierreInput,
  context: { ip: string; userAgent: string },
): Promise<ForzarCierreResult> => {
  const sucursal = texto(input.sucursal, 120);
  const motivo = texto(input.motivo, 500);
  if (sucursal === '' || motivo === '') {
    throw new AppError('Hay que indicar la sucursal y el motivo', 422, 'FALTAN_DATOS');
  }

  const fondoInicial = Math.max(0, input.declaracion.fondoInicial);
  const efectivoDeclarado = Math.max(0, input.declaracion.efectivo);
  const tarjetaDeclarada = Math.max(0, input.declaracion.tarjeta);
  const transferenciaDeclarada = Math.max(0, input.declaracion.transferencia);
  const gastosDeclarados = Math.max(0, input.declaracion.gastos);
  const dryRun = input.dryRun === true;

  const resultado = await withTransaction(async (session) => {
    // Solo los no arqueados: es lo mismo que filtra esCandidatoCierreForzado,
    // pero recorta el volumen antes de traerlo.
    const docs = await Order.find({ sucursal, arqueado: { $ne: true } })
      .session(session)
      .limit(MAX_TICKETS)
      .exec();

    const crudas = docs.map((doc) => ({
      id: String(doc._id),
      /* Las banderas booleanas se coercionan ACA.
         Los documentos importados de Firestore guardaron estas banderas como objetos
         (Timestamps y centinelas), y cualquier validacion aguas abajo los rechaza:
           Valor invalido para el campo "arqueado": [object Object]
         Es el 400 que impedia el cierre forzado de esos turnos. Se normaliza en el borde,
         una sola vez, en vez de confiar en que la limpieza de datos ya corrio: un turno
         viejo que quede sin limpiar no puede volver a tumbar el cierre. */
      venta: {
        ...(doc.toObject() as unknown as VentaCruda),
        arqueado: doc.arqueado === true,
        noAfectaCaja: doc.noAfectaCaja === true,
      } as VentaCruda,
    }));

    const grupo = agruparCierreForzado(crudas, sucursal);
    if (!grupo || grupo.ventas.length === 0) {
      throw new AppError(
        'No hay tickets sin arquear del turno activo para esta sucursal',
        409,
        'SIN_TICKETS_PENDIENTES',
      );
    }

    const totales = sumarAportes(grupo.ventas);
    const productos = agruparProductos(grupo.ventas);
    const masAntigua = grupo.ventas.reduce((a, b) => (a.fecha <= b.fecha ? a : b)).venta;
    const fechaApertura =
      (masAntigua['fechaAperturaTurno'] instanceof Date
        ? (masAntigua['fechaAperturaTurno'] as Date)
        : null) ??
      (masAntigua['fecha'] instanceof Date ? (masAntigua['fecha'] as Date) : null) ??
      new Date();

    const totalEsperadoEfectivo = fondoInicial + totales.efectivo - gastosDeclarados;
    const totalEsperado = totalEsperadoEfectivo + totales.tarjeta + totales.transferencia;
    const totalDeclarado = efectivoDeclarado + tarjetaDeclarada + transferenciaDeclarada;
    const totalVendido = totales.efectivo + totales.tarjeta + totales.transferencia + totales.credito;
    const cierreDate = new Date();

    const base: ForzarCierreResult = {
      ok: true,
      dryRun,
      turnoId: grupo.turnoId,
      sucursal,
      tickets: grupo.ventas.length,
      totals: totales,
      totalEsperado,
      totalDeclarado,
      totalVendido,
      difference: totalDeclarado - totalEsperado,
      fechaApertura,
    };

    if (dryRun) return base;

    return escribirCierre({
      base,
      ids: grupo.ventas.map((v) => v.id),
      turnoId: grupo.turnoId,
      productos,
      session,
      forzadoPor: input.forzadoPor,
      forzadoPorNombre: input.forzadoPorNombre,
      htmlTicket: input.htmlTicket,
      context,
      cierreDate,
      motivo,
      totales,
      numeros: {
        fondoInicial,
        efectivoDeclarado,
        tarjetaDeclarada,
        transferenciaDeclarada,
        gastosDeclarados,
      },
      derivados: { totalEsperadoEfectivo, totalEsperado, totalDeclarado, totalVendido },
    });
  });

  if (!resultado.dryRun) {
    emitTurnoEvent(resultado.sucursal, 'turno:cerrado', {
      turnoId: resultado.turnoId,
      id: resultado.cierreId ?? null,
      total: resultado.totalEsperado,
    });
  }

  return resultado;
};

/** Todo lo que necesita la parte que escribe, en un objeto para no arrastrar 18 parametros. */
interface EscrituraCierre {
  base: ForzarCierreResult;
  ids: string[];
  turnoId: string;
  productos: Record<string, { cant: number; total: number }>;
  session: ClientSession | null;
  forzadoPor?: string | undefined;
  forzadoPorNombre?: string | undefined;
  htmlTicket?: string | undefined;
  context: { ip: string; userAgent: string };
  cierreDate: Date;
  motivo: string;
  totales: TotalesCierre;
  numeros: {
    fondoInicial: number;
    efectivoDeclarado: number;
    tarjetaDeclarada: number;
    transferenciaDeclarada: number;
    gastosDeclarados: number;
  };
  derivados: {
    totalEsperadoEfectivo: number;
    totalEsperado: number;
    totalDeclarado: number;
    totalVendido: number;
  };
}

/**
 * Marca los tickets como arqueados, crea el cierre, cierra el turno y audita.
 * Las cuatro escrituras van juntas en la misma transaccion: si se marcaran los
 * tickets y fallara la creacion del cierre, el turno desapareceria del flujo sin
 * arqueo y esa plata no quedaria registrada en ningun lado.
 */
const escribirCierre = async (e: EscrituraCierre): Promise<ForzarCierreResult> => {
  const { numeros: n, derivados: d, totales: t } = e;
  const sesion = e.session ?? undefined;

  await Order.updateMany(
    { _id: { $in: e.ids } },
    {
      $set: {
        arqueado: true,
        fechaArqueo: e.cierreDate,
        cierreForzado: true,
        motivoCierreForzado: e.motivo,
        cierreForzadoPor: e.forzadoPorNombre ?? 'Sistema',
        cierreForzadoPorId: e.forzadoPor ?? null,
      },
    },
    { session: sesion },
  );

  const diferenciaEfectivo = n.efectivoDeclarado - d.totalEsperadoEfectivo;
  const diferenciaTarjeta = n.tarjetaDeclarada - t.tarjeta;
  const diferenciaTransferencia = n.transferenciaDeclarada - t.transferencia;

  const cierre = await CashClose.create(
    [
      {
        turnoId: e.turnoId,
        turnosIncluidos: [e.turnoId],
        sucursal: e.base.sucursal,
        cajeroId: null,
        cajero: 'Cierre forzado por admin',
        fechaApertura: e.base.fechaApertura,
        fechaCierre: e.cierreDate,
        fechaOperacionKey: fechaKey(e.base.fechaApertura),
        fechaCierreKey: fechaKey(e.cierreDate),
        fondoInicial: n.fondoInicial,
        declaracion: {
          efectivo: n.efectivoDeclarado,
          gastos: n.gastosDeclarados,
          tarjeta: n.tarjetaDeclarada,
          transferencia: n.transferenciaDeclarada,
          totalCaja: d.totalDeclarado,
        },
        sistema: {
          ventasEfectivo: t.efectivo,
          ventasTarjeta: t.tarjeta,
          ventasTransferencia: t.transferencia,
          ventasCredito: t.credito,
          fondoInicial: n.fondoInicial,
          totalEsperadoEfectivo: d.totalEsperadoEfectivo,
          totalEsperado: d.totalEsperado,
          totalCobradoInmediato: t.efectivo + t.tarjeta + t.transferencia,
          totalVendido: d.totalVendido,
          diferenciaEfectivo,
          diferenciaTarjeta,
          diferenciaTransferencia,
          diferenciaTotal: d.totalDeclarado - d.totalEsperado,
        },
        resumenFinanciero: {
          efectivoPos: t.efectivo,
          efectivoDeclarado: n.efectivoDeclarado,
          efectivoEsperado: d.totalEsperadoEfectivo,
          posTarjeta: t.tarjeta,
          transferencia: t.transferencia,
          credito: t.credito,
          gastos: n.gastosDeclarados,
          fondoInicial: n.fondoInicial,
          diferenciaCaja: diferenciaEfectivo,
          diferenciaTotal: d.totalDeclarado - d.totalEsperado,
          sobrante: Math.max(diferenciaEfectivo, 0),
          faltante: Math.max(-diferenciaEfectivo, 0),
        },
        versionEsquemaFinanciero: 2,
        productosVendidos: e.productos,
        ticketsContados: e.ids.length,
        ticketsTurnoIds: e.ids,
        cierreForzado: true,
        motivoCierreForzado: e.motivo,
        forzadoPor: e.forzadoPorNombre ?? 'Sistema',
        forzadoPorId: e.forzadoPor ?? '',
        htmlTicket: e.htmlTicket ?? '',
        creadoEn: e.cierreDate,
      },
    ],
    { session: sesion },
  );

  const cierreId = String(cierre[0]?._id ?? '');

  await CashShift.updateOne(
    { turnoId: e.turnoId },
    {
      $set: {
        estadoTurno: 'cerrado',
        cierreCajaId: cierreId,
        cerradoEn: e.cierreDate,
        cierreForzado: true,
        cierreForzadoPorId: e.forzadoPor ?? null,
      },
    },
    { session: sesion },
  );

  await AuditLog.create(
    [
      {
        tipo: 'cierre_forzado_caja',
        origen: 'api',
        sucursal: e.base.sucursal,
        turnoId: e.turnoId,
        totalDespues: d.totalEsperado,
        totalAntes: d.totalDeclarado,
        motivo: e.motivo,
        adminId: e.forzadoPor ?? '',
        adminNombre: e.forzadoPorNombre ?? 'Sistema',
        detalle: {
          diferenciaTotal: d.totalDeclarado - d.totalEsperado,
          tickets: e.ids.length,
          cierreId,
        },
        ip: e.context.ip,
        userAgent: e.context.userAgent,
        fecha: e.cierreDate,
      },
    ],
    { session: sesion },
  );

  return { ...e.base, cierreId };
};
