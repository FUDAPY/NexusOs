import { Order, OrderItem } from '../models/index.js';
import { AppError } from '../utils/response.js';
import { withTransaction } from '../utils/withTransaction.js';
import { filtroPorId } from '../utils/mongoId.js';
import { emitTurnoEvent } from '../sockets/kds.js';
import { recordAudit } from './audit.service.js';
import { aplicarSaldoCliente, applyStockMovements, prepareItems } from './order.service.js';
import type { CreateOrderInput } from '../schemas/order.schema.js';

export interface CerrarCuentaInput {
  metodoPago: string;
  /**
   * Los items que se venden, con el MISMO contrato que POST /orders.
   *
   * Son los del carrito en el momento de cobrar, no los de la orden guardada: el
   * cajero puede haber agregado algo a la mesa antes de pasar por caja. El total
   * se recalcula con ellos del lado del servidor, asi que el valor que mande el
   * navegador no decide nada.
   */
  items: CreateOrderInput['items'];
  cajero?: string;
  puntosOtorgados?: number;
  puntosCanjeados?: number;
  /** Descuento global (premium). Los descuentos por item vienen dentro de cada item. */
  discountAmount?: number;
  observacion?: string;
  creditoLibre?: boolean;
  clienteId?: string;
  detalleEfectivo?: Record<string, unknown>;
  detallesPago?: Record<string, unknown>;
  /**
   * Turno en el que se esta COBRANDO la mesa.
   *
   * Una mesa se abre en un turno y se puede cobrar en otro (queda abierta de
   * noche y se paga a la manana). La venta tiene que quedar en el turno donde
   * ENTRA LA PLATA, no donde se abrio: si quedara en el turno viejo, su cierre ya
   * paso y esa venta no se contaria en ningun arqueo. El POS legacy hacia
   * exactamente esto al cobrar.
   */
  turnoId?: string;
  fechaAperturaTurno?: Date;
}

export interface CerrarCuentaResult {
  orderId: string;
  ticketId: string;
  total: number;
  estadoPago: string;
}

/**
 * Cierra (cobra) una cuenta pendiente: la mesa que quedo abierta.
 *
 * POR QUE EXISTE
 * El POS abre las mesas como ordenes con `estadoPago: 'pendiente'`. Cobrarlas
 * exige PASAR esa orden a pagada, no crear otra: POST /orders siempre crea, asi
 * que sin este endpoint cobrar una mesa DUPLICABA la venta.
 *
 * ALCANCE DELIBERADO: solo el caso en que los items NO cambiaron.
 * Si el carrito cambio (agregaron un postre, sacaron una bebida) hay que ajustar
 * el stock por diferencia, y ademas el stock vive en DOS lugares (los items
 * embebidos en la orden y la coleccion order_items). Eso es otro paso. Hasta
 * entonces un cambio de items responde 409 CUENTA_CON_CAMBIOS en vez de cerrar
 * la cuenta con el stock mal: fallar ruidoso es mejor que descuadrar.
 */
export const cerrarCuentaPendiente = async (
  ordenId: string,
  input: CerrarCuentaInput,
  context: { ip: string; userAgent: string },
): Promise<CerrarCuentaResult> => {
  if (String(input.metodoPago ?? '').trim() === '') {
    throw new AppError('Falta el metodo de pago', 400, 'MISSING_METODO_PAGO');
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new AppError('La cuenta necesita al menos un item', 400, 'MISSING_ITEMS');
  }

  const resultado = await withTransaction(async (session) => {
    const orden = await Order.findOne(filtroPorId(ordenId)).session(session).exec();
    if (!orden) throw new AppError('No existe esa cuenta', 404, 'NOT_FOUND');
    if (orden.estadoPago !== 'pendiente') {
      throw new AppError(
        `Esa cuenta ya no esta pendiente (${orden.estadoPago})`,
        409,
        'CUENTA_YA_CERRADA',
      );
    }

    /* Los items del cuerpo son los que se venden, y el total se recalcula con ellos
       igual que en una venta directa: el navegador no decide la plata. Ademas se
       guardan en la orden, asi lo que queda registrado es lo que se cobro.
       Esto es lo que permite AGREGAR algo a una mesa ya abierta: el cajero suma el
       postre en el POS y cobra, sin pasar por un ajuste de stock por diferencia. */
    const { prepared, bruto } = await prepareItems({ items: input.items }, session);
    const items = prepared.map((p) => p.item);
    const total = Math.max(bruto - (input.discountAmount ?? Number(orden.discountAmount ?? 0)), 0);

    /* El stock de la mesa se mueve ACA, al cobrarla: al abrirla no se toco (ver el
       comentario en createOrder). Es el mismo movimiento que hace una venta directa,
       con el mismo guard de concurrencia contra sobreventa. */
    await applyStockMovements(prepared, session);

    const esCredito = input.metodoPago === 'Credito' || input.metodoPago === 'Crédito';
    const canjeados = Math.max(0, input.puntosCanjeados ?? 0);
    /* Misma regla que una venta directa: 1 punto por cada 1.000 Gs, y NO se otorgan si
       la cuenta se paga a credito (esa plata no entro: se otorgan cuando pague la deuda)
       ni si canjeo puntos. */
    const puntosOtorgados = esCredito || canjeados > 0 ? 0 : Math.floor(total / 1000);

    orden.estadoPago = 'pagado';
    orden.items = items;
    orden.subtotal = bruto;
    orden.total = total;
    // El metodo llega como string del POS; el modelo lo tiene como union de
    // literales, asi que se castea en el unico lugar donde se asigna.
    orden.metodoPago = input.metodoPago as typeof orden.metodoPago;
    orden.puntosOtorgados = puntosOtorgados;
    orden.puntosCanjeados = canjeados;
    if (typeof input.observacion === 'string') orden.observacion = input.observacion;
    orden.confirmadoPorCaja = true;
    orden.fechaConfirmacionCaja = new Date();

    // La venta se muda al turno donde se cobra (ver el comentario del input).
    if (typeof input.turnoId === 'string' && input.turnoId.trim() !== '') {
      orden.turnoId = input.turnoId.trim();
    }
    if (input.fechaAperturaTurno) orden.fechaAperturaTurno = input.fechaAperturaTurno;

    if (input.detalleEfectivo) {
      const d = input.detalleEfectivo;
      orden.detalleEfectivo = {
        monedaCobro: String(d['monedaCobro'] ?? 'PYG'),
        tasaCambioAplicada: Number(d['tasaCambioAplicada'] ?? 1),
        montoRecibidoMoneda: Number(d['montoRecibidoMoneda'] ?? 0),
        montoRecibidoGs: Number(d['montoRecibidoGs'] ?? 0),
        vueltoGs: Number(d['vueltoGs'] ?? 0),
      };
    }
    if (input.detallesPago) orden.detallesPago = input.detallesPago;

    await orden.save({ session: session ?? undefined });

    // Misma funcion que usa la venta directa: una sola forma de mover el saldo.
    await aplicarSaldoCliente(
      {
        clienteId: input.clienteId ?? orden.cliente,
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
        tipo: 'cuenta_cerrada',
        origen: 'pos',
        motivo: `Cuenta ${orden.ticket_id} cerrada por ${input.metodoPago}`,
        sucursal: orden.sucursal,
        adminNombre: input.cajero ?? '',
        ticketId: orden.ticket_id,
        ventaId: String(orden._id),
        nombreCliente: orden.nombreCliente,
        estadoPago: orden.estadoPago,
        metodoPago: input.metodoPago,
        totalDespues: total,
        detalle: { ip: context.ip, userAgent: context.userAgent },
      },
      session,
    );

    return {
      orderId: String(orden._id),
      ticketId: orden.ticket_id,
      total,
      estadoPago: orden.estadoPago,
      sucursal: orden.sucursal,
    };
  });

  // Despues del commit: el dashboard tiene que ver el cambio ya confirmado.
  emitTurnoEvent(resultado.sucursal, 'venta:creada', { turnoId: null });

  return {
    orderId: resultado.orderId,
    ticketId: resultado.ticketId,
    total: resultado.total,
    estadoPago: resultado.estadoPago,
  };
};

export interface ActualizarCuentaInput {
  items: CreateOrderInput['items'];
  discountAmount?: number;
  observacion?: string;
  estadoCocina?: CreateOrderInput['estadoCocina'];
  cajero?: string;
}

/**
 * Guarda una cuenta abierta (mesa) SIN cobrarla: es el "enviar a cocina" del salon,
 * donde el cliente sigue comiendo y paga despues.
 *
 * NO mueve stock ni plata, y es a proposito:
 *  - el stock se mueve al COBRAR (ver createOrder y cerrarCuentaPendiente);
 *  - el saldo del cliente, tambien.
 * Por eso la operacion es un REEMPLAZO de los items, no una suma: repetirla no
 * acumula nada y no puede descuadrar. El POS legacy hacia esto sobre Firestore
 * calculando ajustes de stock por diferencia; con el stock moviendose al cobrar ese
 * ajuste ya no hace falta, y con el desaparece la chance de equivocarse en un delta.
 */
export const actualizarCuentaPendiente = async (
  ordenId: string,
  input: ActualizarCuentaInput,
  context: { ip: string; userAgent: string },
): Promise<{ orderId: string; ticketId: string; total: number; estadoCocina: string }> => {
  const resultado = await withTransaction(async (session) => {
    const orden = await Order.findOne(filtroPorId(ordenId)).session(session).exec();
    if (!orden) throw new AppError('No existe esa cuenta', 404, 'NOT_FOUND');
    if (orden.estadoPago !== 'pendiente') {
      throw new AppError(
        `Esa cuenta ya no esta pendiente (${orden.estadoPago})`,
        409,
        'CUENTA_YA_CERRADA',
      );
    }

    // prepareItems valida el stock disponible pero NO lo mueve: eso pasa al cobrar.
    const { prepared, bruto } = await prepareItems({ items: input.items }, session);
    const items = prepared.map((p) => p.item);
    const total = Math.max(bruto - (input.discountAmount ?? Number(orden.discountAmount ?? 0)), 0);

    orden.items = items;
    orden.subtotal = bruto;
    orden.total = total;
    if (typeof input.observacion === 'string') orden.observacion = input.observacion;
    if (input.estadoCocina) orden.estadoCocina = input.estadoCocina;
    await orden.save({ session: session ?? undefined });

    /* order_items es la copia normalizada que escribio createOrder. Se reemplaza
       entera en vez de calcular diferencias: es mas simple y no puede quedar una
       fila huerfana de un item que se saco de la mesa. */
    await OrderItem.deleteMany({ orderId: orden._id }, session ? { session } : {});
    await OrderItem.insertMany(
      items.map((item) => ({
        ...item,
        orderId: orden._id,
        productoId: item.id,
        ticket_id: orden.ticket_id,
        sucursal: orden.sucursal,
        fecha: orden.fecha,
      })),
      session ? { session, ordered: true } : { ordered: true },
    );

    await recordAudit(
      {
        tipo: 'cuenta_actualizada',
        origen: 'pos',
        motivo: `Cuenta ${orden.ticket_id} actualizada sin cobrar (${items.length} items)`,
        sucursal: orden.sucursal,
        adminNombre: input.cajero ?? '',
        ticketId: orden.ticket_id,
        ventaId: String(orden._id),
        nombreCliente: orden.nombreCliente,
        estadoPago: orden.estadoPago,
        totalDespues: total,
        detalle: { ip: context.ip, userAgent: context.userAgent },
      },
      session,
    );

    return {
      orderId: String(orden._id),
      ticketId: orden.ticket_id,
      total,
      estadoCocina: orden.estadoCocina,
      sucursal: orden.sucursal,
    };
  });

  // La cocina tiene que enterarse de los items nuevos: mismo evento que una venta.
  emitTurnoEvent(resultado.sucursal, 'venta:creada', { turnoId: null });

  return {
    orderId: resultado.orderId,
    ticketId: resultado.ticketId,
    total: resultado.total,
    estadoCocina: resultado.estadoCocina,
  };
};
