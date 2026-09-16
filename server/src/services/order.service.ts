import { Types, type ClientSession } from 'mongoose';
import { Order, OrderItem, Product, type IOrder, type IOrderItem } from '../models/index.js';
import type { CreateOrderInput } from '../schemas/order.schema.js';
import { AppError } from '../utils/response.js';
import { withTransaction } from '../utils/withTransaction.js';
import { emitTurnoEvent } from '../sockets/kds.js';
import { recordAudit } from './audit.service.js';

type OrderItemInput = CreateOrderInput['items'][number];

interface PreparedItem {
  item: IOrderItem;
  productId: string;
}

const round = (value: number): number => Math.round(value);

const descuentoItem = (item: OrderItemInput): number =>
  item.descuento + item.descuentoVip + item.descuentoBogo;

/** Calcula subtotales por item y valida existencia/stock contra el catalogo. */
const prepareItems = async (
  input: CreateOrderInput,
  session: ClientSession | null,
): Promise<{ prepared: PreparedItem[]; bruto: number }> => {
  const ids = [...new Set(input.items.map((item) => item.id))].filter((id) =>
    Types.ObjectId.isValid(id),
  );

  const products =
    ids.length > 0
      ? await Product.find({ _id: { $in: ids } })
          .session(session)
          .lean()
          .exec()
      : [];
  const byId = new Map(products.map((product) => [String(product._id), product]));

  const prepared: PreparedItem[] = [];
  let bruto = 0;

  for (const raw of input.items) {
    const product = byId.get(raw.id);

    if (product && product.controlado === true && product.stock < raw.cantidad) {
      throw new AppError(
        `Stock insuficiente para ${product.nombre} (disponible: ${product.stock})`,
        409,
        'INSUFFICIENT_STOCK',
      );
    }

    const subtotal = Math.max(raw.cantidad * raw.precio - descuentoItem(raw), 0);
    bruto += subtotal;

    prepared.push({
      productId: raw.id,
      item: {
        id: raw.id,
        uniqueId: Date.now(),
        nombre: raw.nombre,
        categoria: raw.categoria,
        cantidad: raw.cantidad,
        precio: round(raw.precio),
        controlado: raw.controlado,
        descuento: raw.descuento,
        descuentoVip: raw.descuentoVip,
        descuentoBogo: raw.descuentoBogo,
        promocionBogo: raw.promocionBogo,
        codigo: raw.codigo,
        icono: raw.icono,
        obsProd: raw.obsProd,
        subtotal,
      },
    });
  }

  return { prepared, bruto };
};

const applyStockMovements = async (
  prepared: PreparedItem[],
  session: ClientSession | null,
): Promise<void> => {
  for (const { item, productId } of prepared) {
    if (item.controlado !== true || !Types.ObjectId.isValid(productId)) continue;

    // Filtro stock >= cantidad: descuento atomico que evita sobreventa concurrente.
    const updated = await Product.findOneAndUpdate(
      { _id: new Types.ObjectId(productId), controlado: true, stock: { $gte: item.cantidad } },
      { $inc: { stock: -item.cantidad } },
      { new: true, session },
    ).exec();

    if (!updated) {
      throw new AppError(
        `Stock insuficiente para ${item.nombre} (movimiento concurrente detectado)`,
        409,
        'INSUFFICIENT_STOCK',
      );
    }

    await Product.updateOne(
      { _id: updated._id },
      [{ $set: { agotado: { $and: [{ $eq: ['$controlado', true] }, { $lte: ['$stock', 0] }] } } }],
      { session: session ?? undefined },
    ).exec();
  }
};

/** Formato de ticket observado en produccion: T-###### */
const buildTicketId = (): string => `T-${Math.floor(Math.random() * 900_000) + 100_000}`;

export interface CreateOrderResult {
  order: IOrder;
  /** Id del documento; se expone aparte porque IOrder no declara _id. */
  orderId: string;
  itemIds: string[];
}

export const createOrder = async (
  input: CreateOrderInput,
  context: { ip: string; userAgent: string },
): Promise<CreateOrderResult> => {
  const resultado = await withTransaction(async (session) => {
    const { prepared, bruto } = await prepareItems(input, session);
    const items = prepared.map((entry) => entry.item);
    const total = Math.max(bruto - input.discountAmount, 0);

    await applyStockMovements(prepared, session);

    const esCredito = input.metodoPago === 'Credito' || input.metodoPago === 'Crédito';
    const ticketId = input.ticket_id ?? buildTicketId();

    const [orderDoc] = await Order.create(
      [
        {
          ticket_id: ticketId,
          tipoTransaccion: input.tipoTransaccion,
          total,
          cajero: input.cajero,
          cajeroCobro: input.cajeroCobro || input.cajero,
          cliente: input.cliente,
          nombreCliente: input.nombreCliente,
          aliasReferencia: input.aliasReferencia || input.nombreCliente,
          items,
          fecha: new Date(),
          estadoCocina: input.estadoCocina,
          observacion: input.observacion,
          metodoPago: input.metodoPago,
          estadoPago: esCredito ? 'pendiente' : 'pagado',

          subtotal: bruto,
          discountAmount: input.discountAmount,
          noAfectaCaja: input.noAfectaCaja || input.metodoPago === 'Gratis',
          motivoNoAfectaCaja: input.motivoNoAfectaCaja,

          puntosOtorgados: input.puntosOtorgados,
          puntosCanjeados: input.puntosCanjeados,

          detalleEfectivo: input.detalleEfectivo ?? null,
          turnoId: input.turnoId,
          sucursal: input.sucursal,
          sucursalId: input.sucursalId ? new Types.ObjectId(input.sucursalId) : null,
        },
      ],
      session ? { session } : {},
    );

    if (!orderDoc) {
      throw new AppError('No se pudo crear la orden', 500, 'ORDER_CREATE_FAILED');
    }

    const itemDocs = await OrderItem.insertMany(
      items.map((item) => ({
        ...item,
        orderId: orderDoc._id,
        productoId: item.id,
        ticket_id: ticketId,
        sucursal: input.sucursal,
        fecha: orderDoc.fecha,
      })),
      session ? { session, ordered: true } : { ordered: true },
    );

    await recordAudit(
      {
        tipo: 'venta_registrada',
        origen: 'pos',
        motivo: `Ticket ${ticketId} por Gs. ${total.toLocaleString('es-PY')}`,
        sucursal: input.sucursal,
        adminNombre: input.cajero,
        ticketId,
        ventaId: String(orderDoc._id),
        nombreCliente: input.nombreCliente,
        estadoPago: orderDoc.estadoPago,
        metodoPago: input.metodoPago,
        totalDespues: total,
        detalle: { items: items.length, ip: context.ip, userAgent: context.userAgent },
      },
      session,
    );

    return {
      order: orderDoc.toObject() as IOrder,
      orderId: String(orderDoc._id),
      itemIds: itemDocs.map((doc) => String(doc._id)),
    };
  });

  // Se emite DESPUES del commit: si se emitiera adentro, el frontend pediria
  // datos que todavia no estan confirmados y veria el estado viejo.
  // De esto depende que el "turno actual" del dashboard se actualice solo.
  emitTurnoEvent(resultado.order.sucursal ?? input.sucursal, 'venta:creada', {
    turnoId: resultado.order.turnoId ?? input.turnoId ?? null,
    id: resultado.orderId,
    ticketId: resultado.order.ticket_id ?? null,
    total: Number(resultado.order.total ?? 0),
    estadoPago: resultado.order.estadoPago ?? null,
    productos: resultado.order.items
      .filter((item) => item.controlado === true)
      .map((item) => ({ productoId: String(item.id ?? ''), cantidad: Number(item.cantidad ?? 0) })),
  });

  return resultado;
};
