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
  
  items: CreateOrderInput['items'];
  cajero?: string;
  puntosOtorgados?: number;
  puntosCanjeados?: number;
  
  discountAmount?: number;
  observacion?: string;
  creditoLibre?: boolean;
  clienteId?: string;
  detalleEfectivo?: Record<string, unknown>;
  detallesPago?: Record<string, unknown>;
  
  turnoId?: string;
  fechaAperturaTurno?: Date;
}

export interface CerrarCuentaResult {
  orderId: string;
  ticketId: string;
  total: number;
  estadoPago: string;
}


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

    
    const { prepared, bruto } = await prepareItems({ items: input.items }, session);
    const items = prepared.map((p) => p.item);
    const total = Math.max(bruto - (input.discountAmount ?? Number(orden.discountAmount ?? 0)), 0);

    
    await applyStockMovements(prepared, session);

    const esCredito = input.metodoPago === 'Credito' || input.metodoPago === 'Crédito';
    const canjeados = Math.max(0, input.puntosCanjeados ?? 0);
    
    const puntosOtorgados = esCredito || canjeados > 0 ? 0 : Math.floor(total / 1000);

    orden.estadoPago = 'pagado';
    orden.items = items;
    orden.subtotal = bruto;
    orden.total = total;

    orden.metodoPago = input.metodoPago as typeof orden.metodoPago;
    orden.puntosOtorgados = puntosOtorgados;
    orden.puntosCanjeados = canjeados;
    if (typeof input.observacion === 'string') orden.observacion = input.observacion;
    orden.confirmadoPorCaja = true;
    orden.fechaConfirmacionCaja = new Date();


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

/* - el stock se mueve al COBRAR (ver createOrder y cerrarCuentaPendiente); */
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


    const { prepared, bruto } = await prepareItems({ items: input.items }, session);
    const items = prepared.map((p) => p.item);
    const total = Math.max(bruto - (input.discountAmount ?? Number(orden.discountAmount ?? 0)), 0);

    orden.items = items;
    orden.subtotal = bruto;
    orden.total = total;
    if (typeof input.observacion === 'string') orden.observacion = input.observacion;
    if (input.estadoCocina) orden.estadoCocina = input.estadoCocina;
    await orden.save({ session: session ?? undefined });

    
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


  emitTurnoEvent(resultado.sucursal, 'venta:creada', { turnoId: null });

  return {
    orderId: resultado.orderId,
    ticketId: resultado.ticketId,
    total: resultado.total,
    estadoCocina: resultado.estadoCocina,
  };
};
