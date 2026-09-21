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

      deudaResultante = Math.max(0, deudaAnterior - total);

      
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
