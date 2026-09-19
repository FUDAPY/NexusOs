import { AppError } from '../utils/response.js';
import { withTransaction } from '../utils/withTransaction.js';
import { filtroPorId } from '../utils/mongoId.js';
import { AuditLog, Order, User } from '../models/index.js';
import type { IOrder } from '../models/index.js';
import { emitTurnoEvent } from '../sockets/kds.js';

export type AccionCobro = 'aprobar' | 'rechazar';

export interface ResolverCobroInput {
  orderId: string;
  accion: AccionCobro;
  autorizadoPor?: string;
  autorizadoPorNombre?: string;
}

export interface ResolverCobroResult {
  order: IOrder;
  orderId: string;
  accion: AccionCobro;
  deudaAnterior: number;
  deudaResultante: number;
}

/**
 * Aprueba o rechaza el cobro de un abono de deuda.
 *
 * Reemplaza el `writeBatch` del dashboard, que tocaba DOS colecciones
 * (users.deuda y sales) en una sola operacion. En Mongo eso es una transaccion,
 * y tiene que serlo: si la orden quedara como 'aprobado' pero la deuda del
 * cliente no bajara, el cliente seguiria debiendo plata ya pagada.
 *
 * La guarda de `estadoAprobacionCobro === 'pendiente'` es lo que impide aplicar
 * la misma aprobacion dos veces. Sin ella, un doble clic o un reintento REST
 * descontaba la deuda por duplicado.
 */
export const resolverCobro = async (
  input: ResolverCobroInput,
  context: { ip: string; userAgent: string },
): Promise<ResolverCobroResult> => {
  const resultado = await withTransaction(async (session) => {
    const order = await Order.findOne(filtroPorId(input.orderId)).session(session).exec();
    if (!order) {
      throw new AppError(`No existe la orden ${input.orderId}`, 404, 'ORDER_NOT_FOUND');
    }
    if (order.tipoTransaccion !== 'abono_deuda') {
      throw new AppError('Solo los abonos de deuda se aprueban o rechazan', 422, 'NO_ES_ABONO_DEUDA');
    }

    const estadoActual = String(order.estadoAprobacionCobro ?? 'pendiente').toLowerCase();
    if (estadoActual !== 'pendiente') {
      throw new AppError(
        `El cobro ya fue ${estadoActual}. No se puede volver a resolver.`,
        409,
        'COBRO_YA_RESUELTO',
      );
    }

    const total = Number(order.total ?? 0);
    const aprobar = input.accion === 'aprobar';
    let deudaAnterior = 0;
    let deudaResultante = 0;

    if (aprobar) {
      // El cliente de la venta es el uid de Firestore, por eso se busca por
      // `uid` y no solo por _id.
      const cliente = await User.findOne(filtroPorId(String(order.cliente ?? ''), 'uid'))
        .session(session)
        .exec();

      if (!cliente) {
        throw new AppError(
          `No existe el cliente ${String(order.cliente ?? '')} para aplicar el abono`,
          404,
          'CLIENTE_NOT_FOUND',
        );
      }

      deudaAnterior = Number(cliente.deuda ?? 0);
      // Nunca por debajo de cero: si el abono supera la deuda, el excedente no
      // se convierte en saldo a favor (asi se comportaba el dashboard).
      deudaResultante = Math.max(0, deudaAnterior - total);

      /* Los puntos por pagar la deuda (1 por cada 1.000 Gs pagados) se otorgan ACA, que es
         cuando el pago se vuelve real: el cobrador solo lo REGISTRO, y hasta que
         administracion no lo aprueba esa plata no entro.
         Es la misma regla que aplica POST /orders/pagar-deuda para un cobro directo. Sin
         esto, pagar por un cobrador no daba puntos y pagar en el mostrador si: la misma
         regla aplicada a medias. */
      const puntosOtorgados = Math.floor(total / 1000);

      await User.updateOne(
        { _id: cliente._id },
        { $set: { deuda: deudaResultante }, $inc: { puntos: puntosOtorgados } },
        { session: session ?? undefined },
      );
    }

    const actualizada = await Order.findOneAndUpdate(
      { _id: order._id },
      {
        $set: {
          estadoAprobacionCobro: aprobar ? 'aprobado' : 'rechazado',
          deudaAplicada: aprobar,
          estadoPago: aprobar ? 'pagado' : 'rechazado',
          aprobadoPor: input.autorizadoPorNombre ?? 'Sistema',
          fechaAprobacionCobro: new Date(),
        },
      },
      { new: true, session: session ?? undefined },
    ).exec();

    if (!actualizada) {
      throw new AppError('No se pudo actualizar la orden', 500, 'ORDER_UPDATE_FAILED');
    }

    await AuditLog.create(
      [
        {
          tipo: aprobar ? 'cobro_aprobado' : 'cobro_rechazado',
          origen: 'api',
          motivo: `${aprobar ? 'Aprobacion' : 'Rechazo'} de abono por Gs. ${total.toLocaleString('es-PY')}`,
          ticketId: order.ticket_id ?? null,
          ventaId: String(order._id),
          sucursal: order.sucursal ?? '',
          clienteId: String(order.cliente ?? ''),
          nombreCliente: order.nombreCliente ?? 'Cliente',
          totalAntes: deudaAnterior,
          totalDespues: deudaResultante,
          adminId: input.autorizadoPor ?? '',
          adminNombre: input.autorizadoPorNombre ?? 'Sistema',
          ip: context.ip,
          userAgent: context.userAgent,
          fecha: new Date(),
        },
      ],
      { session: session ?? undefined },
    );

    return {
      order: actualizada.toObject() as IOrder,
      orderId: String(actualizada._id),
      accion: input.accion,
      deudaAnterior,
      deudaResultante,
    };
  });

  /* Se emite despues del commit. Se reusa 'venta:creada' porque no hay un evento
     de "venta modificada" y el consumidor hace lo mismo con todos: refetch. Si
     algun dia se quiere distinguir, agregar 'venta:actualizada' a EventoTurno. */
  emitTurnoEvent(resultado.order.sucursal ?? '', 'venta:creada', {
    turnoId: resultado.order.turnoId ?? null,
    id: resultado.orderId,
    ticketId: resultado.order.ticket_id ?? null,
    total: Number(resultado.order.total ?? 0),
    estadoPago: resultado.order.estadoPago ?? null,
  });

  return resultado;
};

export interface MarcarAbonadoInput {
  orderId: string;
  motivo: string;
  autorizadoPor?: string;
  autorizadoPorNombre?: string;
}

/**
 * Excluye un ticket del flujo de caja SIN anularlo.
 *
 * Es distinto de anular: no devuelve stock ni cambia el estado de pago, solo
 * marca el ticket para que no cuente en el arqueo (ej. lo paga un encargado por
 * fuera). Por eso no comparte el endpoint de anulacion.
 */
export const marcarComoAbonado = async (
  input: MarcarAbonadoInput,
  context: { ip: string; userAgent: string },
): Promise<{ order: IOrder; orderId: string }> => {
  const motivo = input.motivo.trim();
  if (motivo === '') {
    throw new AppError('Hay que indicar el motivo', 422, 'MOTIVO_REQUERIDO');
  }

  const resultado = await withTransaction(async (session) => {
    const order = await Order.findOne(filtroPorId(input.orderId)).session(session).exec();
    if (!order) {
      throw new AppError(`No existe la orden ${input.orderId}`, 404, 'ORDER_NOT_FOUND');
    }
    if (order.marcadoComoAbonado === true) {
      throw new AppError('Este ticket ya estaba marcado como abonado', 409, 'YA_ABONADO');
    }

    const actualizada = await Order.findOneAndUpdate(
      { _id: order._id },
      {
        $set: {
          marcadoComoAbonado: true,
          motivoMarcadoAbonado: motivo,
          marcadoComoAbonadoPor: input.autorizadoPorNombre ?? 'Sistema',
          fechaMarcadoComoAbonado: new Date(),
        },
      },
      { new: true, session: session ?? undefined },
    ).exec();

    if (!actualizada) {
      throw new AppError('No se pudo actualizar la orden', 500, 'ORDER_UPDATE_FAILED');
    }

    await AuditLog.create(
      [
        {
          tipo: 'marcado_abonado_flujo',
          origen: 'api',
          motivo,
          ticketId: order.ticket_id ?? null,
          ventaId: String(order._id),
          sucursal: order.sucursal ?? '',
          nombreCliente: order.nombreCliente ?? 'Cliente',
          totalAntes: Number(order.total ?? 0),
          totalDespues: 0,
          adminId: input.autorizadoPor ?? '',
          adminNombre: input.autorizadoPorNombre ?? 'Sistema',
          ip: context.ip,
          userAgent: context.userAgent,
          fecha: new Date(),
        },
      ],
      { session: session ?? undefined },
    );

    return { order: actualizada.toObject() as IOrder, orderId: String(actualizada._id) };
  });

  emitTurnoEvent(resultado.order.sucursal ?? '', 'venta:creada', {
    turnoId: resultado.order.turnoId ?? null,
    id: resultado.orderId,
    ticketId: resultado.order.ticket_id ?? null,
    total: Number(resultado.order.total ?? 0),
    estadoPago: resultado.order.estadoPago ?? null,
  });

  return resultado;
};
