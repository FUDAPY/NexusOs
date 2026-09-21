import { Types, type ClientSession } from 'mongoose';
import { Order, OrderItem, Product, User, type IOrder, type IOrderItem } from '../models/index.js';
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


export const prepareItems = async (
  input: Pick<CreateOrderInput, 'items'>,
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

export const applyStockMovements = async (
  prepared: PreparedItem[],
  session: ClientSession | null,
): Promise<void> => {
  for (const { item, productId } of prepared) {
    if (item.controlado !== true || !Types.ObjectId.isValid(productId)) continue;


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


const buildTicketId = (): string => `T-${Math.floor(Math.random() * 900_000) + 100_000}`;

export interface CreateOrderResult {
  order: IOrder;
  
  orderId: string;
  itemIds: string[];
}


export const aplicarSaldoCliente = async (
  params: {
    clienteId?: string;
    puntosOtorgados?: number;
    puntosCanjeados?: number;
    creditoLibre?: boolean;
    
    ajustePuntos?: number;
  },
  total: number,
  esCredito: boolean,
  session: ClientSession | null,
): Promise<void> => {
  const clienteId = String(params.clienteId ?? '').trim();
  if (clienteId === '' || clienteId === 'ocasional') return;

  const canjeados = Math.max(0, params.puntosCanjeados ?? 0);
  const deltaPuntos = Math.max(0, params.puntosOtorgados ?? 0) - canjeados + (params.ajustePuntos ?? 0);
  // Credito libre en la sucursal: el POS sumaba la deuda y la restaba en la
  // misma transaccion (neto 0). Aca directamente no se suma.
  const deltaDeuda = esCredito && params.creditoLibre !== true ? total : 0;

  if (deltaPuntos === 0 && deltaDeuda === 0) return;


  const filtro: Record<string, unknown> = Types.ObjectId.isValid(clienteId)
    ? { $or: [{ uid: clienteId }, { _id: new Types.ObjectId(clienteId) }] }
    : { uid: clienteId };


  if (deltaPuntos < 0) filtro['puntos'] = { $gte: canjeados };

  const actualizado = await User.findOneAndUpdate(
    filtro,
    { $inc: { puntos: deltaPuntos, deuda: deltaDeuda } },
    { new: true, session: session ?? undefined },
  ).exec();

  if (actualizado === null) {

    throw new AppError(
      deltaPuntos < 0
        ? 'No se pudo canjear: el cliente no existe o no tiene puntos suficientes'
        : 'No se pudo actualizar el saldo del cliente',
      409,
      'SALDO_CLIENTE_NO_APLICADO',
    );
  }
};

export const createOrder = async (
  input: CreateOrderInput,
  context: { ip: string; userAgent: string },
): Promise<CreateOrderResult> => {
  const resultado = await withTransaction(async (session) => {
    const { prepared, bruto } = await prepareItems(input, session);
    const items = prepared.map((entry) => entry.item);
    const total = Math.max(bruto - input.discountAmount, 0);

    
    if (input.origenCuentaPendiente !== true) {
      await applyStockMovements(prepared, session);
    }

    const esCredito = input.metodoPago === 'Credito' || input.metodoPago === 'Crédito';
    const ticketId = input.ticket_id ?? buildTicketId();

    /* - en una venta a CREDITO: esa plata todavia no entro. Se otorgan cuando el cliente
   PAGA su deuda, sobre el monto que paga. */
    const canjeados = Math.max(0, input.puntosCanjeados ?? 0);
    const puntosOtorgados = esCredito || canjeados > 0 ? 0 : Math.floor(total / 1000);

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
          estadoPago: input.estadoPago ?? (esCredito ? 'pendiente' : 'pagado'),

          subtotal: bruto,
          discountAmount: input.discountAmount,
          noAfectaCaja: input.noAfectaCaja || input.metodoPago === 'Gratis',
          motivoNoAfectaCaja: input.motivoNoAfectaCaja,
          origenCuentaPendiente: input.origenCuentaPendiente,

          puntosOtorgados,
          puntosCanjeados: canjeados,

          detalleEfectivo: input.detalleEfectivo ?? null, detallesPago: input.detallesPago ?? null,
          turnoId: input.turnoId, fechaAperturaTurno: input.fechaAperturaTurno ?? null,
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


    // transaccion: ver aplicarSaldoCliente.
    await aplicarSaldoCliente(
      {
        clienteId: input.clienteId,
        puntosOtorgados,
        puntosCanjeados: canjeados,
        creditoLibre: input.creditoLibre,
      },
      total,
      esCredito,
      session,
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
