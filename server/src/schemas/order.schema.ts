import { z } from 'zod';
import { ESTADOS_COCINA, ESTADOS_PAGO, METODOS_PAGO, TIPOS_TRANSACCION } from '../models/Order.js';

export const orderItemInputSchema = z.object({
  id: z.string().default(''),
  nombre: z.string().min(1).max(180),
  categoria: z.string().max(120).default('Sin Categoria'),
  cantidad: z.number().int().min(1).max(999),
  precio: z.number().min(0),
  controlado: z.boolean().default(false),
  descuento: z.number().min(0).default(0),
  descuentoVip: z.number().min(0).default(0),
  descuentoBogo: z.number().min(0).default(0),
  promocionBogo: z.boolean().default(false),
  codigo: z.string().max(60).default(''),
  icono: z.string().max(60).default('fa-box'),
  obsProd: z.string().max(300).default(''),
});

export const detalleEfectivoSchema = z.object({
  monedaCobro: z.string().max(8).default('PYG'),
  tasaCambioAplicada: z.number().min(0).default(1),
  montoRecibidoMoneda: z.number().min(0).default(0),
  montoRecibidoGs: z.number().min(0).default(0),
  vueltoGs: z.number().min(0).default(0),
});

export const createOrderInputSchema = z.object({
  ticket_id: z.string().min(1).max(40).optional(),
  tipoTransaccion: z.enum(TIPOS_TRANSACCION).default('venta_comida'),
  sucursal: z.string().min(1).max(140),
  sucursalId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  turnoId: z.string().min(1).max(80).optional(),

  cajero: z.string().min(1).max(140),
  cajeroCobro: z.string().max(140).default(''),
  cliente: z.string().max(140).default('ocasional'),
  /**
   * Cliente CRM al que hay que moverle puntos y deuda.
   *
   * Va aparte de `cliente` (que es el nombre que se imprime en el ticket)
   * porque el saldo vive en un documento de `users` y hay que identificarlo.
   * Vacio u 'ocasional' = venta de mostrador, no hay saldo que mover.
   */
  clienteId: z.string().max(60).default(''),
  nombreCliente: z.string().max(140).default('Fisico 1'),
  aliasReferencia: z.string().max(140).default(''),

  items: z.array(orderItemInputSchema).min(1, 'El ticket requiere al menos un item'),

  metodoPago: z.enum(METODOS_PAGO).default('Efectivo'),
  estadoCocina: z.enum(ESTADOS_COCINA).default('pendiente'),

  /**
   * Estado de pago. Si NO viene, se deriva del metodo: Crédito queda
   * 'pendiente' y el resto 'pagado' (comportamiento actual de la API).
   *
   * Por que es opcional y no fijo: el POS legacy marcaba la venta **'pagado'
   * SIEMPRE** y sumaba la deuda del cliente por separado. Migrar la venta sin
   * esto cambiaria dos cosas en silencio: el arqueo, y que **cada venta a
   * credito apareceria como una MESA ABIERTA** — porque 'pendiente' es
   * justamente lo que el POS usa para las cuentas abiertas.
   *
   * Dejarlo opcional permite que el POS conserve el comportamiento viejo sin
   * cambiarle el comportamiento a los otros consumidores de POST /orders.
   */
  estadoPago: z.enum(ESTADOS_PAGO).optional(),

  /**
   * El cliente tiene credito libre en la sucursal: NO se le suma deuda.
   *
   * El POS legacy sumaba y restaba la deuda en la misma transaccion (neto 0).
   * Sin este campo, migrar la venta le sumaria deuda donde antes no le sumaba.
   */
  creditoLibre: z.boolean().default(false),

  /** Cuando se abrio el turno. El cierre forzado lo usa para fechar la apertura. */
  fechaAperturaTurno: z.coerce.date().optional(),

  /** Detalle del pago mixto, tal como lo manda el POS. */
  detallesPago: z.record(z.unknown()).optional(),
  observacion: z.string().max(400).default(''),
  discountAmount: z.number().min(0).default(0),
  detalleEfectivo: detalleEfectivoSchema.optional(),
  puntosOtorgados: z.number().int().min(0).default(0),
  puntosCanjeados: z.number().int().min(0).default(0),
  noAfectaCaja: z.boolean().default(false),
  motivoNoAfectaCaja: z.string().max(200).default(''),

  /**
   * La orden es una CUENTA ABIERTA (mesa), no una venta cerrada.
   *
   * El POS lo escribe al guardar una mesa y el modelo ya declara el campo; lo
   * que faltaba era dejarlo pasar por la validacion. Sin esto zod lo descartaba
   * en silencio y la orden quedaba sin la marca.
   */
  origenCuentaPendiente: z.boolean().default(false),
});

export type CreateOrderInput = z.infer<typeof createOrderInputSchema>;

export const listOrdersQuerySchema = z.object({
  sucursal: z.string().min(1).optional(),
  turnoId: z.string().min(1).optional(),
  estadoPago: z.string().min(1).optional(),
  estadoCocina: z.string().min(1).optional(),
  desde: z.coerce.date().optional(),
  hasta: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  /* `offset` es la paginacion que usa el RESTO del sistema: la capa de recursos hace
     .skip(offset) y NexusData.leerTodo manda ese parametro. Aca no existia, asi que el
     endpoint lo ignoraba y devolvia SIEMPRE la misma pagina: el lector paginado acumulaba
     filas repetidas hasta su tope. Los dos conviven a proposito: `page` lo usan las pantallas
     que ya estaban, `offset` el lector nuevo. */
  offset: z.coerce.number().int().min(0).optional(),
  /* 200 era el tope y las pantallas de reportes piden 500: la API devolvia 200 en silencio
     y el reporte historico quedaba cortado sin que nadie se enterara. Se sube a 1000, que es
     headroom real para el historico de un ano. El tope no obliga a nadie a pedir tanto: el
     POS y el dashboard siguen pidiendo decenas. */
  limit: z.coerce.number().int().min(1).max(1000).default(50),
});

export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;
