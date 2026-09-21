import { AppError } from '../utils/response.js';
import { sumarAportes, type TotalesCierre, type VentaCruda } from '../utils/cashFlow.js';
import { withTransaction } from '../utils/withTransaction.js';
import { AuditLog, CashClose, CashShift, Order } from '../models/index.js';
import { emitTurnoEvent } from '../sockets/kds.js';

export interface CerrarTurnoInput {
  turnoId: string;
  /** Lo que el cajero conto fisicamente en cada medio. */
  declaracion: {
    efectivo: number;
    tarjeta: number;
    transferencia: number;
    gastos?: number;
  };
  cajero: string;
  cajeroId?: string | null;
  observacion?: string;
  forzado?: boolean;
  motivoForzado?: string;
  /**
   * Ticket Z ya renderizado por el POS.
   *
   * Se guarda tal cual para que el relatorio pueda reimprimir el MISMO ticket
   * que se le dio al cliente, igual que cuando el POS escribia el cierre a
   * Firestore. Es informativo: NO entra en ningun calculo.
   */
  htmlTicket?: string;
}

export interface CerrarTurnoResult {
  cierreId: string;
  turnoId: string;
  esperado: { efectivo: number; tarjeta: number; transferencia: number; total: number };
  declarado: { efectivo: number; tarjeta: number; transferencia: number; total: number };
  /** declarado - esperado. Positivo = sobrante, negativo = faltante. */
  diferencia: { efectivo: number; tarjeta: number; transferencia: number; total: number };
  ticketsContados: number;
}

const redondear = (n: number): number => Math.round(Number.isFinite(n) ? n : 0);

/** Normaliza el metodo de pago para compararlo sin acentos ni mayusculas. */
const normalizar = (valor: unknown): string => {
  // Se exige string explicito: si llegara un objeto, String(obj) daria
  // '[object Object]' y el metodo de pago nunca coincidiria.
  const texto = typeof valor === 'string' ? valor : '';
  return texto
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
};

/**
 * Cierre de caja (Cierre Z) del cajero.
 *
 * Todo dentro de una transaccion: si falla la creacion del cierre, el turno
 * NO queda cerrado. Los totales NO se reciben del cliente: se recalculan desde
 * las ordenes del turno, para que nadie pueda declarar un esperado falso.
 */
export const cerrarTurno = async (
  input: CerrarTurnoInput,
  context: { ip: string; userAgent: string },
): Promise<CerrarTurnoResult> => {
  // Se captura aca para poder emitir el evento DESPUES del commit, cuando la
  // variable `turno` que vive dentro de la transaccion ya no esta en alcance.
  let sucursalTurno = '';

  const resultado = await withTransaction(async (session) => {
    const opciones = session ? { session } : {};

    const turno = await CashShift.findOne({ turnoId: input.turnoId }).session(session).exec();
    if (!turno) {
      throw new AppError(`No existe el turno ${input.turnoId}`, 404, 'SHIFT_NOT_FOUND');
    }
    if (turno.estadoTurno === 'cerrado') {
      throw new AppError('El turno ya estaba cerrado', 409, 'SHIFT_ALREADY_CLOSED');
    }
    sucursalTurno = turno.sucursal ?? '';

    // --- Totales reales, recalculados desde las ordenes del turno ---
    // Se excluyen las anuladas y las que no afectan caja (canjes gratuitos).
    const ordenes = await Order.find({
      turnoId: input.turnoId,
      estadoPago: { $ne: 'anulado' },
      $or: [{ noAfectaCaja: false }, { noAfectaCaja: { $exists: false } }],
    })
      .session(session)
      .lean()
      .exec();

    let efectivo = 0;
    let tarjeta = 0;
    let transferencia = 0;
    const ticketsTurnoIds: string[] = [];
    const productosVendidos: Record<string, number> = {};

    for (const orden of ordenes) {
      const total = Number(orden.total ?? 0);
      const metodo = normalizar(orden.metodoPago);

      if (metodo.includes('efectivo')) efectivo += total;
      else if (metodo.includes('tarjeta') || metodo.includes('pos')) tarjeta += total;
      else if (metodo.includes('transferencia')) transferencia += total;
      // Credito y Gratis no entran al arqueo: son deuda o cortesia.

      ticketsTurnoIds.push(orden.ticket_id ?? String(orden._id));

      const items = (orden.items ?? []) as { nombre?: string; cantidad?: number }[];
      for (const item of items) {
        const nombre = String(item.nombre ?? '');
        if (nombre === '') continue;
        productosVendidos[nombre] = (productosVendidos[nombre] ?? 0) + Number(item.cantidad ?? 0);
      }
    }

    const fondoInicial = Number(turno.fondoInicial ?? 0);
    const gastos = redondear(input.declaracion.gastos ?? 0);
    /* Los gastos SALEN del cajon: el cajero los pago en efectivo.
       Se restan del esperado, que es lo que hacia el POS legacy
       (totalEsperadoEfectivo = fondo + ventas efectivo - gastos) y por lo tanto
       lo que ya quedo guardado en los cierres migrados. Sin restarlos, la
       diferencia de un cierre nuevo no seria comparable con la de los viejos:
       con Gs. 100.000 de gastos, el MISMO arqueo daria 100.000 de mas. */
    const esperadoEfectivo = redondear(fondoInicial + efectivo - gastos);
    const esperadoTarjeta = redondear(tarjeta);
    const esperadoTransferencia = redondear(transferencia);
    const esperadoTotal = redondear(esperadoEfectivo + esperadoTarjeta + esperadoTransferencia);

    const declEfectivo = redondear(input.declaracion.efectivo);
    const declTarjeta = redondear(input.declaracion.tarjeta);
    const declTransferencia = redondear(input.declaracion.transferencia);
    const declaradoTotal = redondear(declEfectivo + declTarjeta + declTransferencia);

    const difEfectivo = redondear(declEfectivo - esperadoEfectivo);
    const difTarjeta = redondear(declTarjeta - esperadoTarjeta);
    const difTransferencia = redondear(declTransferencia - esperadoTransferencia);
    const difTotal = redondear(declaradoTotal - esperadoTotal);
    const ahora = new Date();

    const [cierre] = await CashClose.create(
      [
        {
          turnoId: input.turnoId,
          sucursal: turno.sucursal,
          sucursalId: turno.sucursalId ? String(turno.sucursalId) : null,
          cajeroId: input.cajeroId ?? null,
          cajero: input.cajero,

          fechaApertura: turno.fechaApertura ?? null,
          fechaCierre: ahora,
          fondoInicial,

          declaracion: {
            efectivo: declEfectivo,
            tarjeta: declTarjeta,
            transferencia: declTransferencia,
            gastos,
            observacion: input.observacion ?? '',
          },
          sistema: {
            efectivoPos: redondear(efectivo),
            tarjetaPOS: esperadoTarjeta,
            transferencia: esperadoTransferencia,
            totalEsperado: esperadoTotal,
            totalCobradoInmediato: redondear(efectivo + tarjeta + transferencia),
            ticketsContados: ticketsTurnoIds.length,
          },
          resumenFinanciero: {
            esperadoEfectivo,
            declaradoEfectivo: declEfectivo,
            diferenciaEfectivo: difEfectivo,
            esperadoTarjeta,
            declaradoTarjeta: declTarjeta,
            diferenciaTarjeta: difTarjeta,
            esperadoTransferencia,
            declaradoTransferencia: declTransferencia,
            diferenciaTransferencia: difTransferencia,
            gastos,
            totalEsperado: esperadoTotal,
            totalDeclarado: declaradoTotal,
            diferenciaTotal: difTotal,
            sobrante: Math.max(difTotal, 0),
            faltante: Math.max(-difTotal, 0),
          },
          productosVendidos,
          ticketsContados: ticketsTurnoIds.length,
          ticketsTurnoIds,
          versionEsquemaFinanciero: 2,
          htmlTicket: input.htmlTicket ?? '',

          cierreForzado: input.forzado === true,
          motivoCierreForzado: input.forzado === true ? (input.motivoForzado ?? '') : '',

          creadoEn: ahora,
        },
      ],
      opciones,
    );

    if (!cierre) {
      throw new AppError('No se pudo crear el cierre de caja', 500, 'CLOSE_CREATE_FAILED');
    }

    /* Cerrar el turno tiene que CERRAR las ventas, no solo sumarlas.
       Sin esto las ordenes quedan con arqueado:false para siempre y siguen
       contando en el flujo de caja, que es justo lo que el cajero espera que
       deje de pasar al cerrar su caja:
         - utils/cashFlow.ts (calcularAporte) solo excluye las arqueado === true
         - cashForzado.service.ts filtra { arqueado: { $ne: true } }, asi que un
           cierre forzado posterior volveria a contar estas mismas ventas
       Se usa la MISMA consulta con la que se calcularon los totales: lo que se
       cierra es exactamente lo que se conto, ni una venta mas ni una menos.
       Va dentro de la transaccion por el mismo motivo que en el cierre forzado
       (ver escribirCierre): tickets marcados sin cierre guardado es plata que
       desaparece del flujo sin quedar auditada en ningun lado. */
    await Order.updateMany(
      {
        turnoId: input.turnoId,
        estadoPago: { $ne: 'anulado' },
        $or: [{ noAfectaCaja: false }, { noAfectaCaja: { $exists: false } }],
      },
      { $set: { arqueado: true, fechaArqueo: ahora } },
      opciones,
    );

    await CashShift.updateOne(
      { _id: turno._id },
      { $set: { estadoTurno: 'cerrado', closedAt: ahora, updatedAt: ahora } },
      opciones,
    );

    await AuditLog.create(
      [
        {
          tipo: 'cierre_caja',
          subtipo: input.forzado === true ? 'forzado' : 'normal',
          motivo: input.observacion ?? 'Cierre Z',
          ventaId: String(cierre._id),
          sucursal: turno.sucursal,
          nombreCliente: input.cajero,
          totalAntes: esperadoTotal,
          totalDespues: declaradoTotal,
          ip: context.ip,
          userAgent: context.userAgent,
          fecha: ahora,
        },
      ],
      opciones,
    );

    return {
      cierreId: String(cierre._id),
      turnoId: input.turnoId,
      esperado: {
        efectivo: esperadoEfectivo,
        tarjeta: esperadoTarjeta,
        transferencia: esperadoTransferencia,
        total: esperadoTotal,
      },
      declarado: {
        efectivo: declEfectivo,
        tarjeta: declTarjeta,
        transferencia: declTransferencia,
        total: declaradoTotal,
      },
      diferencia: {
        efectivo: difEfectivo,
        tarjeta: difTarjeta,
        transferencia: difTransferencia,
        total: difTotal,
      },
      ticketsContados: ticketsTurnoIds.length,
    };
  });

  // Se emite DESPUES del commit: si se emitiera adentro, el frontend pediria
  // datos que todavia no estan confirmados y veria el estado viejo otra vez.
  emitTurnoEvent(sucursalTurno, 'turno:cerrado', {
    turnoId: input.turnoId,
    id: resultado.cierreId,
    total: resultado.declarado.total,
    estadoPago: 'cerrado',
  });

  return resultado;
};

export interface ReconciliarTurnoResult {
  turnoId: string;
  sucursal: string;
  /** Totales recalculados desde los tickets reales del turno. */
  summary: TotalesCierre;
  /** Campo -> (recalculado - guardado). Solo los que cambiaron. */
  differences: Record<string, number>;
}

/** Campos que la pantalla compara. Salen del resumen, no de una lista nueva. */
const CAMPOS_RESUMEN = [
  'ventaTotalBruta',
  'efectivo',
  'tarjetaPOS',
  'transferencia',
  'credito',
  'totalTicketsFlujo',
  'totalTicketsPagados',
] as const;

/**
 * Recalcula el resumen de flujo de un turno DESDE SUS TICKETS REALES.
 *
 * Reemplaza la Cloud Function `reconciliarFlujoTurno`, que ya no existe. Los
 * nombres y la forma del resultado son los mismos a proposito: la pantalla compara
 * lo recalculado contra lo guardado y muestra la diferencia, y asi no hay que tocar
 * esa logica.
 *
 * NO escribe nada, y es deliberado: el resumen es DERIVADO de los tickets. Guardar
 * un derivado a mano es como aparecen los numeros que no cuadran con los tickets que
 * los originaron: quedan los dos y no se sabe cual vale. Si hay que comparar algo,
 * se compara contra lo guardado y se informa; la fuente de verdad son las ordenes.
 */
export const reconciliarFlujoTurno = async (turnoId: string): Promise<ReconciliarTurnoResult> => {
  const id = String(turnoId ?? '').trim();
  if (id === '') {
    throw new AppError('Falta el turnoId', 400, 'MISSING_SHIFT_ID');
  }

  const turno = await CashShift.findOne({ turnoId: id }).lean().exec();
  if (!turno) {
    throw new AppError(`No existe el turno ${id}`, 404, 'SHIFT_NOT_FOUND');
  }

  // Mismo criterio que el cierre: fuera las anuladas y las que no afectan caja.
  //
  // `noAfectaCaja: { $ne: true }` NO se puede usar: Mongoose intenta castear el OPERADOR como
  // si fuera el valor y lanza CastError ("Cast to Boolean failed for value \"{ '$ne': true }\""
  // at path "noAfectaCaja"). Se ve en el log de produccion con el stack en Query._castConditions.
  // Se expresa lo mismo con un $or explicito, que castea sin ambiguedad: el campo es false, o
  // el documento no lo tiene (el default es undefined, asi que la mayoria no lo tiene).
  const ordenes = await Order.find({
    turnoId: id,
    estadoPago: { $ne: 'anulado' },
    $or: [{ noAfectaCaja: false }, { noAfectaCaja: { $exists: false } }],
  })
    .lean()
    .exec();

  const summary = sumarAportes(
    ordenes.map((orden) => ({
      id: String(orden._id),
      /* Misma coercion que en cashForzado.service.ts: los documentos importados de Firestore
         traen estas banderas como objetos y la validacion las rechaza ("Valor invalido para
         el campo ..."). Normalizar en el borde evita que un turno viejo sin limpiar vuelva a
         romper la reconciliacion. */
      venta: {
        ...(orden as unknown as VentaCruda),
        arqueado: orden.arqueado === true,
        noAfectaCaja: orden.noAfectaCaja === true,
      } as VentaCruda,
    })),
  );

  /* `resumen` no esta declarado en el modelo, asi que se lee sin tipar: si falta, se
     compara contra cero, que es justo lo que la pantalla espera cuando el resumen
     todavia no se inicializo. */
  const guardado = ((turno as unknown as { resumen?: Record<string, unknown> }).resumen ?? {}) as Record<
    string,
    unknown
  >;

  const differences: Record<string, number> = {};
  const calculado = summary as unknown as Record<string, number>;
  for (const campo of CAMPOS_RESUMEN) {
    const nuevo = Number(calculado[campo] ?? 0);
    const viejo = Number(guardado[campo] ?? 0);
    if (nuevo !== viejo) differences[campo] = nuevo - viejo;
  }

  return { turnoId: id, sucursal: String(turno.sucursal ?? ''), summary, differences };
};
