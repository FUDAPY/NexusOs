import { AppError } from '../utils/response.js';
import { withTransaction } from '../utils/withTransaction.js';
import { AuditLog, InventoryMovement, Order, OrderItem, Product } from '../models/index.js';
import type { IOrder } from '../models/index.js';

export interface CancelOrderInput {
  orderId: string;
  motivo: string;
  /** 'total' anula todo; 'parcial' devuelve solo las unidades indicadas. */
  tipo: 'total' | 'parcial';
  /** Para anulacion parcial: { productoId: cantidad } */
  cantidades?: Record<string, number>;
  autorizadoPor?: string;
  autorizadoPorNombre?: string;
}

export interface CancelOrderResult {
  order: IOrder;
  unidadesDevueltas: number;
  productosAfectados: string[];
}

/**
 * Anula una orden (parcial o total) devolviendo el stock.
 *
 * Todo o nada: si falla la devolucion de stock, la orden NO queda anulada.
 * Por cada producto controlado se registra el movimiento inverso en
 * inventory_movements, para que el kardex cuadre con el stock.
 */
export const cancelOrder = async (
  input: CancelOrderInput,
  context: { ip: string; userAgent: string },
): Promise<CancelOrderResult> =>
  withTransaction(async (session) => {
    const order = await Order.findById(input.orderId).session(session).exec();
    if (!order) {
      throw new AppError(`No existe la orden ${input.orderId}`, 404, 'ORDER_NOT_FOUND');
    }
    if (order.estadoPago === 'anulado') {
      throw new AppError('La orden ya estaba anulada', 409, 'ORDER_ALREADY_CANCELLED');
    }

    const items = await OrderItem.find({ orderId: order._id }).session(session).exec();

    // Cantidad a devolver por producto: total = todo; parcial = lo indicado.
    const aDevolver = new Map<string, number>();
    let unidadesDevueltas = 0;

    for (const item of items) {
      const productoId = String(item.productoId ?? '');
      if (productoId === '') continue;
      if (item.controlado !== true) continue;

      const cantidadOrden = Number(item.cantidad ?? 0);
      const pedida =
        input.tipo === 'total' ? cantidadOrden : Number(input.cantidades?.[productoId] ?? 0);
      const cantidad = Math.max(0, Math.min(Math.trunc(pedida), cantidadOrden));
      if (cantidad <= 0) continue;

      aDevolver.set(productoId, (aDevolver.get(productoId) ?? 0) + cantidad);
      unidadesDevueltas += cantidad;
    }

    // Devolucion de stock + movimiento de kardex inverso.
    for (const [productoId, cantidad] of aDevolver) {
      const producto = await Product.findById(productoId).session(session).exec();
      if (!producto) continue;

      const stockAnterior = Number(producto.stock ?? 0);
      const stockResultante = stockAnterior + cantidad;

      await Product.updateOne(
        { _id: producto._id },
        { $set: { stock: stockResultante } },
        { session: session ?? undefined },
      );

      await InventoryMovement.create(
        [
          {
            productoId,
            nombreProducto: producto.nombre ?? '',
            sucursal: order.sucursal ?? '',
            sucursalId: order.sucursalId ? String(order.sucursalId) : null,
            tipo: 'ANULACION',
            motivo: input.motivo,
            cantidad,
            cantidadAnterior: stockAnterior,
            cantidadResultante: stockResultante,
            ventaId: order.ticket_id ?? String(order._id),
            turnoId: order.turnoId ?? null,
            usuario: input.autorizadoPorNombre ?? 'Sistema',
            usuarioId: input.autorizadoPor ?? null,
            fecha: new Date(),
            estado: 'aplicado',
            // Idempotencia: si se reintenta la misma anulacion no se duplica.
            idempotencyKey: `ANUL-${String(order._id)}-${productoId}`,
          },
        ],
        { session: session ?? undefined },
      );
    }

    const esTotal = input.tipo === 'total';
    const actualizada = await Order.findByIdAndUpdate(
      order._id,
      {
        $set: {
          ...(esTotal ? { estadoPago: 'anulado', estadoCocina: 'anulado' } : {}),
          motivoAnulacion: input.motivo,
          fechaAnulacion: new Date(),
          anuladoPor: input.autorizadoPor ?? null,
          anuladoPorNombre: input.autorizadoPorNombre ?? 'Sistema',
          origenAnulacion: 'api',
        },
      },
      { new: true, session: session ?? undefined },
    ).exec();

    await AuditLog.create(
      [
        {
          tipo: 'anulacion_ticket',
          subtipo: esTotal ? 'total' : 'parcial',
          motivo: input.motivo,
          ticketId: order.ticket_id ?? null,
          ventaId: String(order._id),
          sucursal: order.sucursal ?? '',
          clienteId: order.cliente ?? null,
          nombreCliente: order.nombreCliente ?? 'Cliente',
          totalAntes: Number(order.total ?? 0),
          totalDespues: esTotal ? 0 : Number(order.total ?? 0),
          ip: context.ip,
          userAgent: context.userAgent,
          fecha: new Date(),
        },
      ],
      { session: session ?? undefined },
    );

    if (!actualizada) {
      throw new AppError('No se pudo actualizar la orden', 500, 'ORDER_UPDATE_FAILED');
    }

    return {
      order: actualizada.toObject() as IOrder,
      unidadesDevueltas,
      productosAfectados: [...aDevolver.keys()],
    };
  });
