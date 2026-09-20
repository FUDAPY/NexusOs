import { Order, User, type IOrderItem } from '../models/index.js';
import { AppError } from '../utils/response.js';
import { withTransaction } from '../utils/withTransaction.js';
import { filtroPorId } from '../utils/mongoId.js';
import { emitTurnoEvent } from '../sockets/kds.js';
import { recordAudit } from './audit.service.js';

/** 1 punto por cada 1.000 Gs pagados, redondeando abajo. */
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

    /* El filtro exige deuda suficiente en la MISMA operacion que resta: con leer y
       despues escribir habria una ventana donde dos cobros simultaneos dejan la deuda
       en negativo y al cliente con puntos de mas. */
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
          /* El POS legacy excluia los abonos del arqueo (ventaValidaParaCierre). Se
             replica: la plata del abono entra al cajon, pero no se cuenta como venta del
             turno. Marcarlo aca es lo que mantiene ese criterio en un solo lugar. */
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
        /* `totalAntes` es la deuda ANTES del pago. Estaba escrito `deudaActual`, una
           variable que no existe en ninguna parte del archivo: eso es un ReferenceError
           DENTRO de la transaccion, asi que no solo rompia la auditoria: revertia el
           cobro entero. El cliente no podia pagar su deuda.
           El dato ya estaba a mano: es el `cliente` que se lee antes para validar. */
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

  // Despues del commit: el dashboard tiene que ver el ingreso ya confirmado.
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

/**
 * Registra el cobro de la deuda SIN aplicarlo, para que lo apruebe un administrador.
 *
 * POR QUE EXISTE
 * Es el flujo del rol COBRADOR: cobra en la calle y no cierra caja. El POS legacy lo hacia
 * con un setDoc a Firestore, que ya no autoriza, asi que el cobro se perdia. Era el ultimo
 * flujo de plata que no se podia guardar.
 *
 * POR QUE NO TOCA LA DEUDA
 * A proposito, y es toda la diferencia con `pagarDeudaCliente`. Aca el cobro queda
 * REGISTRADO y la deuda del cliente sigue igual hasta que un administrador lo apruebe. Si
 * esto restara la deuda, bastaria con que un cobrador registre un cobro para perdonar una
 * deuda sin respaldo.
 *
 * POR QUE NO OTORGA PUNTOS
 * Por lo mismo: los puntos por pagar la deuda (1 por cada 1.000) se otorgan cuando el pago
 * se vuelve real, o sea al aprobarse. Otorgarlos aca premiaria plata que todavia no entro.
 */
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
  /* No se puede registrar un cobro mayor a la deuda: al aprobarse quedaria en negativo y
     el cliente con puntos de mas. Mejor rechazarlo al registrarlo. */
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
      /* El cobro todavia NO esta pagado: esta pendiente de aprobacion. Marcarlo 'pagado'
         lo haria entrar al arqueo como si la plata ya estuviera en el cajon. */
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
    /* Los dos iguales a proposito: el cobro no movio la deuda. */
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
