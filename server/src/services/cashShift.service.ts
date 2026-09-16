import { AppError } from '../utils/response.js';
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
      noAfectaCaja: { $ne: true },
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
    const esperadoEfectivo = redondear(fondoInicial + efectivo);
    const esperadoTarjeta = redondear(tarjeta);
    const esperadoTransferencia = redondear(transferencia);
    const esperadoTotal = redondear(esperadoEfectivo + esperadoTarjeta + esperadoTransferencia);

    const declEfectivo = redondear(input.declaracion.efectivo);
    const declTarjeta = redondear(input.declaracion.tarjeta);
    const declTransferencia = redondear(input.declaracion.transferencia);
    const gastos = redondear(input.declaracion.gastos ?? 0);
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
        noAfectaCaja: { $ne: true },
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
