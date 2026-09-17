import { Order } from '../models/index.js';
import { AppError } from '../utils/response.js';
import { withTransaction } from '../utils/withTransaction.js';
import { filtroPorId } from '../utils/mongoId.js';
import { emitTurnoEvent } from '../sockets/kds.js';
import { recordAudit } from './audit.service.js';
import { aplicarSaldoCliente } from './order.service.js';

export interface CerrarCuentaItem {
  id: string;
  cantidad: number;
  controlado?: boolean;
}

export interface CerrarCuentaInput {
  metodoPago: string;
  items: CerrarCuentaItem[];
  cajero?: string;
  puntosOtorgados?: number;
  puntosCanjeados?: number;
  observacion?: string;
  creditoLibre?: boolean;
  clienteId?: string;
  detalleEfectivo?: Record<string, unknown>;
  detallesPago?: Record<string, unknown>;
}

export interface CerrarCuentaResult {
  orderId: string;
  ticketId: string;
  total: number;
  estadoPago: string;
}

/**
 * Firma de cantidades por producto controlado, para comparar dos listas.
 */
const firmaControlados = (
  items: { id: string; cantidad: number; controlado?: boolean }[],
): string => {
  const mapa = new Map<string, number>();
  for (const item of items) {
    if (item.controlado !== true) continue;
    mapa.set(item.id, (mapa.get(item.id) ?? 0) + Math.max(0, Math.floor(Number(item.cantidad || 0))));
  }
  return [...mapa.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, n]) => `${id}:${n}`)
    .join('|');
};

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

    // Los items tienen que coincidir. Si no, este endpoint no es el que
    // corresponde: cerrar con el carrito cambiado moveria la plata pero no el
    // stock, y eso se descubre recien en el proximo inventario.
    const originales = (orden.items ?? []) as unknown as CerrarCuentaItem[];
    if (firmaControlados(originales) !== firmaControlados(input.items)) {
      throw new AppError(
        'La cuenta cambio de items: por ahora solo se puede cerrar sin cambios, porque hay que ajustar el stock.',
        409,
        'CUENTA_CON_CAMBIOS',
      );
    }

    const esCredito = input.metodoPago === 'Credito' || input.metodoPago === 'Crédito';
    const total = Number(orden.total ?? 0);

    orden.estadoPago = 'pagado';
    // El metodo llega como string del POS; el modelo lo tiene como union de
    // literales, asi que se castea en el unico lugar donde se asigna.
    orden.metodoPago = input.metodoPago as typeof orden.metodoPago;
    orden.puntosOtorgados = Math.max(0, input.puntosOtorgados ?? 0);
    orden.puntosCanjeados = Math.max(0, input.puntosCanjeados ?? 0);
    if (typeof input.observacion === 'string') orden.observacion = input.observacion;
    orden.confirmadoPorCaja = true;
    orden.fechaConfirmacionCaja = new Date();

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
