import { Types } from 'mongoose';
import { AppError } from '../utils/response.js';
import { withTransaction } from '../utils/withTransaction.js';
import { filtroPorId } from '../utils/mongoId.js';
import { AuditLog, InventoryMovement, Order, OrderItem, Product } from '../models/index.js';
import type { IOrder, IOrderItem } from '../models/index.js';
import { emitTurnoEvent } from '../sockets/kds.js';
import { aplicarSaldoCliente } from './order.service.js';
import { validarCodigoAnulacion } from './anulacionAutorizacion.service.js';
import { logger } from '../utils/logger.js';

export interface CancelOrderInput {
  orderId: string;
  motivo: string;
  /** 'total' anula todo; 'parcial' devuelve solo las unidades indicadas. */
  tipo: 'total' | 'parcial';
  
  cantidades?: Record<string, number>;
  /** Tarjeta RFID (o codigo cargado a mano) que autoriza la anulacion. */
  codigo?: string;
  autorizadoPor?: string;
  autorizadoPorNombre?: string;
}

export interface CancelOrderResult {
  order: IOrder;
  
  orderId: string;
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
): Promise<CancelOrderResult> => {
  // La tarjeta se valida ANTES de abrir la transaccion: si el codigo no es el
  // configurado en settings/sistema, la orden no se toca ni se devuelve stock.
  const autorizacion = await validarCodigoAnulacion(input.codigo);

  const resultado = await withTransaction(async (session) => {
    const order = await Order.findOne(filtroPorId(input.orderId)).session(session).exec();
    if (!order) {
      throw new AppError(`No existe la orden ${input.orderId}`, 404, 'ORDER_NOT_FOUND');
    }
    if (order.estadoPago === 'anulado') {
      throw new AppError('La orden ya estaba anulada', 409, 'ORDER_ALREADY_CANCELLED');
    }

    /* Los items viven EMBEBIDOS en la orden (`order.items`). La coleccion
       `order_items` ya no se usa: consultarla devolvia [] y por eso ni la
       anulacion parcial ni la total devolvian stock. */
    const items = (order.items ?? []) as unknown as {
      productoId?: unknown;
      id?: unknown;
      _id?: unknown;
      cantidad?: unknown;
      controlado?: unknown;
      subtotal?: unknown;
    }[];

    /* El flag `controlado` manda desde el producto: los items viejos pueden no
       traerlo, y con `controlado !== true` se saltaban y no devolvian stock. */
    const idsProductos = items
      .map((item) => String(item.productoId ?? item.id ?? item._id ?? ''))
      .filter((id) => Types.ObjectId.isValid(id));
    const productosDeLaOrden = await Product.find({ _id: { $in: idsProductos } })
      .select('_id controlado')
      .session(session)
      .lean()
      .exec();
    const catalogoControlados = new Map(
      productosDeLaOrden.map((p) => [String(p._id), p.controlado === true]),
    );

    // Cantidad a devolver por producto: total = todo; parcial = lo indicado.
    const aDevolver = new Map<string, number>();
    let unidadesDevueltas = 0;

    /* La anulacion parcial llega con las cantidades indexadas por id de producto,
       pero el cliente puede mandar el id del item de la venta o el _id del propio
       OrderItem. Se prueban las tres claves: si no coincidia ninguna, antes el
       servicio respondia OK sin devolver stock (la anulacion "no hacia nada"). */
    const cantidadPedidaPara = (item: {
      productoId?: unknown;
      id?: unknown;
      _id?: unknown;
    }, productoId: string): number => {
      const claves = [
        productoId,
        String(item.id ?? ''),
        String(item._id ?? ''),
      ].filter((clave) => clave !== '');

      for (const clave of claves) {
        const valor = Number(input.cantidades?.[clave] ?? 0);
        if (valor > 0) return valor;
      }

      return 0;
    };

    for (const item of items) {
      const productoId = String(item.productoId ?? item.id ?? item._id ?? '');
      if (productoId === '') continue;

      const controlado = item.controlado === true || catalogoControlados.get(productoId) === true;
      if (!controlado) continue;

      if (!Types.ObjectId.isValid(productoId)) continue;

      const cantidadOrden = Number(item.cantidad ?? 0);
      const pedida =
        input.tipo === 'total' ? cantidadOrden : cantidadPedidaPara(item, productoId);
      const cantidad = Math.max(0, Math.min(Math.trunc(pedida), cantidadOrden));
      if (cantidad <= 0) continue;

      aDevolver.set(productoId, (aDevolver.get(productoId) ?? 0) + cantidad);
      unidadesDevueltas += cantidad;
    }

    /* Antes esto se guardaba igual y el panel mostraba exito sin haber devuelto
       nada. Ahora la parcial falla de forma explicita y el usuario ve el motivo. */
    if (input.tipo === 'parcial' && unidadesDevueltas === 0) {
      throw new AppError(
        'Ninguna unidad de esta venta coincide con lo pedido (producto no controlado, ya devuelto o id incorrecto)',
        409,
        'PARTIAL_NOTHING_TO_REVERSE',
      );
    }


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

    /* - a credito: se le devuelve lo anulado; */
    const clienteSaldo = String(order.cliente ?? '').trim();
    if (order.estadoPago === 'pagado' && clienteSaldo !== '' && clienteSaldo !== 'ocasional') {
      const metodo = String(order.metodoPago ?? '');
      const esCredito = metodo === 'Credito' || metodo === 'Crédito';
      const totalOrden = Number(order.total ?? 0);

      // Monto anulado: la total es el total; la parcial, las unidades por su precio.
      let montoAnulado = esTotal ? totalOrden : 0;
      if (!esTotal) {
        for (const item of items) {
          const productoId = String(item.productoId ?? '');
          const cantidad = aDevolver.get(productoId) ?? 0;
          if (cantidad <= 0) continue;
          const cantItem = Math.max(1, Number(item.cantidad ?? 1));
          montoAnulado += (Number(item.subtotal ?? 0) / cantItem) * cantidad;
        }
      }
      montoAnulado = Math.round(Math.max(0, montoAnulado));

      const puntosOtorgados = Number(order.puntosOtorgados ?? 0);
      const puntosQueQuedan = esTotal
        ? 0
        : Math.floor(Math.max(0, totalOrden - montoAnulado) / 1000);
      const ajustePuntos = esCredito ? 0 : -Math.max(0, puntosOtorgados - puntosQueQuedan);

      if (montoAnulado > 0 || ajustePuntos < 0) {
        await aplicarSaldoCliente(
          { clienteId: clienteSaldo, puntosOtorgados: 0, puntosCanjeados: 0, ajustePuntos },
          esCredito ? -montoAnulado : 0,
          esCredito,
          session,
        );
      }
    }

    
    if (!esTotal && aDevolver.size > 0) {
      const porSacar = new Map(aDevolver);
      const reducidos: IOrderItem[] = [];
      let quitado = 0;

      for (const item of (order.items ?? []) as IOrderItem[]) {
        const pid = String(item.id ?? '');
        const cantidad = Number(item.cantidad ?? 0);
        const aSacar = porSacar.get(pid) ?? 0;
        if (aSacar <= 0) {
          reducidos.push(item);
          continue;
        }
        porSacar.set(pid, Math.max(0, aSacar - cantidad));
        const queda = Math.max(0, cantidad - aSacar);
        const unitario = cantidad > 0 ? Number(item.subtotal ?? 0) / cantidad : 0;
        quitado += unitario * (cantidad - queda);
        if (queda === 0) continue;
        reducidos.push({ ...item, cantidad: queda, subtotal: Math.round(unitario * queda) });
      }

      const totalNuevo = Math.max(0, Math.round(Number(order.total ?? 0) - quitado));
      const sinNada = reducidos.length === 0 || totalNuevo === 0;

      await Order.updateOne(
        { _id: order._id },
        {
          $set: {
            items: reducidos,
            subtotal: reducidos.reduce((acc, it) => acc + Number(it.subtotal ?? 0), 0),
            total: totalNuevo,
            ...(sinNada ? { estadoPago: 'anulado', estadoCocina: 'anulado' } : {}),
          },
        },
        { session: session ?? undefined },
      );

      await OrderItem.deleteMany({ orderId: order._id }, session ? { session } : {});
      if (reducidos.length > 0) {
        await OrderItem.insertMany(
          reducidos.map((item) => ({
            ...item,
            orderId: order._id,
            productoId: item.id,
            ticket_id: order.ticket_id,
            sucursal: order.sucursal,
            fecha: order.fecha,
          })),
          session ? { session, ordered: true } : { ordered: true },
        );
      }
    }

    await AuditLog.create(
      [
        {
          tipo: 'anulacion_ticket',
          subtipo: esTotal ? 'total' : 'parcial',
          origen: 'api',
          motivo: input.motivo,
          ticketId: order.ticket_id ?? null,
          ventaId: String(order._id),
          sucursal: order.sucursal ?? '',
          clienteId: order.cliente ?? null,
          nombreCliente: order.nombreCliente ?? 'Cliente',
          adminId: input.autorizadoPor ?? '',
          adminNombre: input.autorizadoPorNombre ?? 'Sistema',
          autorizadoPor: input.autorizadoPorNombre ?? 'Sistema',
          // Se guarda que hubo autorizacion con tarjeta, nunca el codigo.
          autorizacionRfid: {
            requerido: autorizacion.requerido,
            verificado: autorizacion.verificado,
            contexto: esTotal ? 'anulacion_total' : 'anulacion_parcial',
          },
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
      orderId: String(actualizada._id),
      unidadesDevueltas,
      productosAfectados: [...aDevolver.keys()],
    };
  });


  emitTurnoEvent(resultado.order.sucursal ?? '', 'venta:anulada', {
    turnoId: resultado.order.turnoId ?? null,
    id: resultado.orderId,
    ticketId: resultado.order.ticket_id ?? null,
    total: Number(resultado.order.total ?? 0),
    estadoPago: 'anulado',

    productos: resultado.order.items
      .filter((item) => item.controlado === true)
      .map((item) => ({ productoId: String(item.id ?? ''), cantidad: Number(item.cantidad ?? 0) })),
  });

  return resultado;
};

export interface CancelarMesasAbiertasInput {
  /** Obligatorio: tarjeta RFID (o codigo cargado a mano) que autoriza el borrado. */
  codigo: string;
  motivo?: string;
  /** Sucursal a limpiar. Sin sucursal se limpian todas las mesas pendientes. */
  sucursal?: string;
  autorizadoPor?: string;
  autorizadoPorNombre?: string;
}

export interface CancelarMesasAbiertasResult {
  anuladas: number;
  omitidas: number;
  tickets: string[];
  totalAnulado: number;
}

/**
 * Borra las mesas abiertas (cuentas pendientes) del POS.
 *
 * No se hace un delete: cada mesa se anula con cancelOrder, o sea que devuelve
 * el stock controlado, revierte la deuda del cliente y queda en audit_logs.
 * Asi ni el kardex ni el arqueo se descuadran y el borrado es rastreable.
 *
 * La tarjeta es obligatoria: sin codigo configurado en admin, o si el codigo no
 * coincide, no se anula nada.
 */
export const cancelarMesasAbiertas = async (
  input: CancelarMesasAbiertasInput,
  context: { ip: string; userAgent: string },
): Promise<CancelarMesasAbiertasResult> => {
  await validarCodigoAnulacion(input.codigo, { obligatorio: true });

  const filtro: Record<string, unknown> = { estadoPago: 'pendiente' };
  const sucursal = String(input.sucursal ?? '').trim();
  if (sucursal !== '') filtro['sucursal'] = sucursal;

  const pendientes = await Order.find(filtro)
    .select('_id ticket_id total sucursal')
    .lean()
    .exec();

  if (pendientes.length === 0) {
    return { anuladas: 0, omitidas: 0, tickets: [], totalAnulado: 0 };
  }

  const motivo = String(input.motivo ?? '').trim() || 'Borrado de mesas abiertas desde POS';
  const tickets: string[] = [];
  let anuladas = 0;
  let omitidas = 0;
  let totalAnulado = 0;

  for (const pendiente of pendientes) {
    try {
      await cancelOrder(
        {
          orderId: String(pendiente._id),
          motivo,
          tipo: 'total',
          codigo: input.codigo,
          autorizadoPor: input.autorizadoPor,
          autorizadoPorNombre: input.autorizadoPorNombre,
        },
        context,
      );

      anuladas += 1;
      totalAnulado += Number(pendiente.total ?? 0);
      tickets.push(String(pendiente.ticket_id ?? pendiente._id));
    } catch (error) {
      // Una mesa que ya no se puede anular (o que otra caja cobro en el medio)
      // no corta la limpieza: se registra y se sigue con las demas.
      omitidas += 1;
      const detalle = error instanceof Error ? error.message : String(error);
      logger.warn(`No se pudo anular la mesa abierta ${String(pendiente._id)}: ${detalle}`);
    }
  }

  emitTurnoEvent(sucursal !== '' ? sucursal : String(pendientes[0]?.sucursal ?? ''), 'mesas:anuladas', {
    mesas: { anuladas, omitidas, tickets, totalAnulado, motivo },
  });

  return { anuladas, omitidas, tickets, totalAnulado };
};
