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

/** Calcula subtotales por item y valida existencia/stock contra el catalogo. */
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

/**
 * Mueve puntos y deuda del cliente, DENTRO de la transaccion de la venta.
 *
 * POR QUE EXISTE
 * El POS hacia esto desde el navegador, en su propio runTransaction. Al migrar
 * el cobro a este endpoint, el saldo del cliente quedaba afuera: el ticket se
 * guardaba con `puntosOtorgados` pero el cliente no sumaba nada. Es el peor tipo
 * de error, porque no se nota al momento: aparece semanas despues como un saldo
 * mal, sin forma de saber que venta lo causo.
 *
 * Meter los dos documentos en la MISMA transaccion es lo que garantiza que o
 * quedan los dos bien, o no queda ninguno.
 *
 * La DEUDA la calcula el servidor desde el total de la orden: un total que llega
 * del navegador no es confiable para tocar una deuda. Los PUNTOS si vienen del
 * input (dependen del carrito, que trae los descuentos por item); lo que hace el
 * servidor es exigir saldo suficiente para el canje.
 */
export const aplicarSaldoCliente = async (
  params: {
    clienteId?: string;
    puntosOtorgados?: number;
    puntosCanjeados?: number;
    creditoLibre?: boolean;
    /**
     * Ajuste de puntos que PUEDE ser negativo. Lo usa la anulacion para devolver
     * los puntos de una venta que ya no existe. `puntosOtorgados` no sirve para
     * eso: se clampea a 0.
     */
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

  // Mismo criterio que filtroPorId: el id puede ser un uid de Firestore o un
  // ObjectId de Mongo, y el frontend manda los dos segun el origen del cliente.
  const filtro: Record<string, unknown> = Types.ObjectId.isValid(clienteId)
    ? { $or: [{ uid: clienteId }, { _id: new Types.ObjectId(clienteId) }] }
    : { uid: clienteId };

  // El saldo se exige en el MISMO filtro que la escritura. Con un `if` previo
  // habria una ventana entre leer y escribir donde otro cobro podria gastar los
  // mismos puntos.
  if (deltaPuntos < 0) filtro['puntos'] = { $gte: canjeados };

  const actualizado = await User.findOneAndUpdate(
    filtro,
    { $inc: { puntos: deltaPuntos, deuda: deltaDeuda } },
    { new: true, session: session ?? undefined },
  ).exec();

  if (actualizado === null) {
    // No se pudo mover el saldo y la venta le iba a mover algo: se corta en vez
    // de guardar el ticket y perder el movimiento en silencio.
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

    /* El stock se mueve cuando la venta se COBRA, no cuando se abre la cuenta.
       Una cuenta pendiente (mesa) es mercaderia servida pero todavia no vendida.
       El POS legacy lo hacia asi y los documentos migrados cuentan con eso: nunca
       se les desconto stock al abrir. Descontarlo aca Y otra vez al cobrar en
       /orders/:id/cerrar-cuenta bajaria el stock DOS veces por la misma mesa.

       Ojo: esto NO aplica a una venta a credito. Una venta a credito es una venta
       TERMINADA (la mercaderia se fue, la deuda queda registrada), asi que su stock
       SI se mueve. Por eso el corte es por `origenCuentaPendiente` y no por
       `estadoPago`, que en las dos cosas vale 'pendiente'. */
    if (input.origenCuentaPendiente !== true) {
      await applyStockMovements(prepared, session);
    }

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
          estadoPago: input.estadoPago ?? (esCredito ? 'pendiente' : 'pagado'),

          subtotal: bruto,
          discountAmount: input.discountAmount,
          noAfectaCaja: input.noAfectaCaja || input.metodoPago === 'Gratis',
          motivoNoAfectaCaja: input.motivoNoAfectaCaja,
          origenCuentaPendiente: input.origenCuentaPendiente,

          puntosOtorgados: input.puntosOtorgados,
          puntosCanjeados: input.puntosCanjeados,

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

    // El saldo del cliente (puntos y deuda) va con la venta, en la MISMA
    // transaccion: ver aplicarSaldoCliente.
    await aplicarSaldoCliente(
      {
        clienteId: input.clienteId,
        puntosOtorgados: input.puntosOtorgados,
        puntosCanjeados: input.puntosCanjeados,
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
