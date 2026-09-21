import { Order, User, type IOrderItem } from '../models/index.js';
import { AppError } from '../utils/response.js';
import { withTransaction } from '../utils/withTransaction.js';
import { filtroPorId } from '../utils/mongoId.js';
import { emitTurnoEvent } from '../sockets/kds.js';
import { recordAudit } from './audit.service.js';


const PUNTOS_POR_MIL = 1000;

export interface PagarDeudaInput {
  monto: number;
  metodoPago?: string;
  cajero?: string;
  sucursal?: string;
  turnoId?: string;
  nombreCliente?: string;
}

export interface PagarDeudaResult {
  clienteId: string;
  deuda: number;
  puntosOtorgados: number;
  puntos: number;
  orderId: string;
  ticketId: string;
  total: number;
}

/**
 * Registra el pago de la deuda de un cliente.
 *
 * POR QUE EXISTE
 * El POS lo hacia con un writeBatch a Firestore: restaba `users.deuda` y creaba un
 * ticket `abono_deuda` a mano. Ya no autoriza, asi que el POS NO PODIA COBRAR UNA
 * DEUDA: otro flujo muerto.
 *
 * AQUI SE OTORGAN LOS PUNTOS POR PAGAR LA DEUDA
 * Es la parte de la regla que faltaba: 1 punto por cada 1.000 Gs PAGADOS. Una compra a
 * credito no otorga al comprar (esa plata no entro): los otorga aca, al pagar, y sobre
 * el monto que paga.
 *
 * Todo en una transaccion: si falla el ticket, la deuda NO baja. Al reves seria plata
 * que el cliente dejo de deber y sin respaldo.
 */
export const pagarDeudaCliente = async (
  clienteId: string,
  input: PagarDeudaInput,
  context: { ip: string; userAgent: string },
): Promise<PagarDeudaResult> => {
  const id = String(clienteId ?? '').trim();
  if (id === '') throw new AppError('Falta el cliente', 400, 'MISSING_CLIENTE');

  const monto = Math.round(Number(input.monto ?? 0));
  if (!Number.isFinite(monto) || monto <= 0) {
    throw new AppError('El monto tiene que ser mayor a cero', 422, 'MONTO_INVALIDO');
  }

  const cliente = await User.findOne(filtroPorId(id)).exec();
  if (!cliente) throw new AppError('No existe ese cliente', 404, 'CLIENTE_INEXISTENTE');

  const puntosOtorgados = Math.floor(monto / PUNTOS_POR_MIL);
  const metodoPago = String(input.metodoPago ?? 'Efectivo');
  const nombreCliente = String(input.nombreCliente ?? cliente.nombre ?? 'Cliente');
  const sucursal = String(input.sucursal ?? cliente.sucursal ?? '');
  const cajero = String(input.cajero ?? 'POS');
  const ticketId = `AB-${Math.floor(Math.random() * 900_000) + 100_000}`;

  const resultado = await withTransaction(async (session) => {
    const opciones = session ? { session } : {};

    
    const actualizado = await User.findOneAndUpdate(
      { ...filtroPorId(id), deuda: { $gte: monto - 1 } },
      { $inc: { deuda: -monto, puntos: puntosOtorgados } },
      { new: true, ...opciones },
    ).exec();

    if (!actualizado) {
      throw new AppError('No se pudo aplicar el pago: revisa la deuda del cliente', 409, 'PAGO_NO_APLICADO');
    }

    const [orden] = await Order.create(
      [
        {
          ticket_id: ticketId,
          tipoTransaccion: 'abono_deuda',
          total: monto,
          cajero,
          cajeroCobro: cajero,
          cliente: id,
          nombreCliente,
          aliasReferencia: nombreCliente,
          items: [] as IOrderItem[],
          fecha: new Date(),
          estadoCocina: 'entregado',
          observacion: '',
          metodoPago,
          estadoPago: 'pagado',
          
          noAfectaCaja: true,
          motivoNoAfectaCaja: 'Pago de deuda de cliente',
          puntosOtorgados,
          puntosCanjeados: 0,
          estadoAprobacionCobro: 'aprobado',
          deudaAplicada: true,
          aprobadoPor: cajero,
          fechaAprobacionCobro: new Date(),
          sucursal,
          turnoId: input.turnoId ?? undefined,
        },
      ],
      opciones,
    );

    if (!orden) throw new AppError('No se pudo registrar el pago', 500, 'ABONO_CREATE_FAILED');

    await recordAudit(
      {
        tipo: 'pago_deuda',
        origen: 'pos',
        motivo: `Pago de deuda por ${monto} (${metodoPago})`,
        sucursal,
        adminNombre: cajero,
        ticketId,
        ventaId: String(orden._id),
        clienteId: id,
        nombreCliente,
        
        totalAntes: Number(cliente.deuda ?? 0),
        totalDespues: Number(actualizado.deuda ?? 0),
        detalle: { ip: context.ip, userAgent: context.userAgent, puntosOtorgados },
      },
      session,
    );

    return {
      clienteId: id,
      deuda: Number(actualizado.deuda ?? 0),
      puntos: Number(actualizado.puntos ?? 0),
      puntosOtorgados,
      orderId: String(orden._id),
      ticketId,
      total: monto,
      sucursal,
    };
  });


  emitTurnoEvent(resultado.sucursal, 'venta:creada', { turnoId: null });

  return {
    clienteId: resultado.clienteId,
    deuda: resultado.deuda,
    puntosOtorgados: resultado.puntosOtorgados,
    puntos: resultado.puntos,
    orderId: resultado.orderId,
    ticketId: resultado.ticketId,
    total: resultado.total,
  };
};

export interface AbonoPendienteInput {
  monto: number;
  metodoPago?: string;
  registradoPor?: string;
  sucursal?: string;
  turnoId?: string;
  nombreCliente?: string;
  observacion?: string;
}

export interface AbonoPendienteResult {
  clienteId: string;
  deuda: number;
  orderId: string;
  ticketId: string;
  total: number;
  estadoAprobacionCobro: string;
}


export const registrarAbonoPendiente = async (
  clienteId: string,
  input: AbonoPendienteInput,
  context: { ip: string; userAgent: string },
): Promise<AbonoPendienteResult> => {
  const id = String(clienteId ?? '').trim();
  if (id === '') throw new AppError('Falta el cliente', 400, 'MISSING_CLIENTE');

  const monto = Math.round(Number(input.monto ?? 0));
  if (!Number.isFinite(monto) || monto <= 0) {
    throw new AppError('El monto tiene que ser mayor a cero', 422, 'MONTO_INVALIDO');
  }

  const cliente = await User.findOne(filtroPorId(id)).exec();
  if (!cliente) throw new AppError('No existe ese cliente', 404, 'CLIENTE_INEXISTENTE');

  const deudaActual = Number(cliente.deuda ?? 0);
  
  if (monto > deudaActual) {
    throw new AppError(
      `El cobro supera la deuda del cliente (${deudaActual} Gs)`,
      422,
      'MONTO_MAYOR_A_DEUDA',
    );
  }

  const metodoPago = String(input.metodoPago ?? 'Efectivo');
  const nombreCliente = String(input.nombreCliente ?? cliente.nombre ?? 'Cliente');
  const sucursal = String(input.sucursal ?? cliente.sucursal ?? '');
  const registradoPor = String(input.registradoPor ?? 'Cobrador');
  const ticketId = `AB-${Math.floor(Math.random() * 900_000) + 100_000}`;

  const [orden] = await Order.create([
    {
      ticket_id: ticketId,
      tipoTransaccion: 'abono_deuda',
      total: monto,
      cajero: registradoPor,
      cajeroCobro: registradoPor,
      cliente: id,
      nombreCliente,
      aliasReferencia: nombreCliente,
      items: [] as IOrderItem[],
      fecha: new Date(),
      estadoCocina: 'entregado',
      observacion: String(input.observacion ?? ''),
      metodoPago,
      
      estadoPago: 'pendiente',
      noAfectaCaja: true,
      motivoNoAfectaCaja: 'Pago de deuda pendiente de aprobacion',
      puntosOtorgados: 0,
      puntosCanjeados: 0,
      estadoAprobacionCobro: 'pendiente',
      deudaAplicada: false,
      cobroRegistradoPorNombre: registradoPor,
      sucursal,
      turnoId: input.turnoId ?? undefined,
    },
  ]);

  if (!orden) throw new AppError('No se pudo registrar el cobro', 500, 'ABONO_CREATE_FAILED');

  await recordAudit({
    tipo: 'pago_deuda',
    origen: 'pos',
    motivo: `Cobro de deuda registrado por ${monto} (${metodoPago}), pendiente de aprobacion`,
    sucursal,
    adminNombre: registradoPor,
    ticketId,
    ventaId: String(orden._id),
    clienteId: id,
    nombreCliente,
    
    totalAntes: deudaActual,
    totalDespues: deudaActual,
    detalle: { ip: context.ip, userAgent: context.userAgent, pendiente: true },
  });

  return {
    clienteId: id,
    deuda: deudaActual,
    orderId: String(orden._id),
    ticketId,
    total: monto,
    estadoAprobacionCobro: 'pendiente',
  };
};
