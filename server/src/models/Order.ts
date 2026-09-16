import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';
import { orderItemSchema, type IOrderItem } from './OrderItem.js';

// Valores observados en produccion (Firestore: sales). Extender solo con evidencia.
export const METODOS_PAGO = [
  'Efectivo',
  'Transferencia',
  'Tarjeta',
  'Credito',
  'Crédito',
  'Mixto',
  'Gratis',
  'Retiro',
] as const;
export type MetodoPago = (typeof METODOS_PAGO)[number];

export const ESTADOS_PAGO = ['pagado', 'pendiente', 'anulado', 'parcial', 'rechazado'] as const;
export type EstadoPago = (typeof ESTADOS_PAGO)[number];

export const TIPOS_TRANSACCION = [
  'venta_comida',
  'abono_deuda',
  'producto_gratis',
  'anulacion',
  'ajuste',
] as const;
export type TipoTransaccion = (typeof TIPOS_TRANSACCION)[number];

export const ESTADOS_COCINA = [
  'pendiente',
  'en_preparacion',
  'listo',
  'entregado',
  'cancelado',
] as const;
export type EstadoCocina = (typeof ESTADOS_COCINA)[number];

/** Cobro en moneda extranjera (Firestore: sales.detalleEfectivo). */
export interface IDetalleEfectivo {
  monedaCobro: string;
  tasaCambioAplicada: number;
  montoRecibidoMoneda: number;
  montoRecibidoGs: number;
  vueltoGs: number;
}

/** Ticket de venta. Firestore: artifacts/erp_lingroup/users/admin_master_001/sales. */
export interface IOrder {
  ticket_id: string;
  tipoTransaccion: TipoTransaccion;
  total: number;
  cajero: string;
  cajeroCobro: string;
  cliente: string;
  nombreCliente: string;
  aliasReferencia: string;
  items: IOrderItem[];
  fecha: Date;
  estadoCocina: EstadoCocina;
  observacion: string;
  metodoPago: MetodoPago;
  estadoPago: EstadoPago;

  // Cuenta pendiente / confirmacion de caja
  origenCuentaPendiente: boolean;
  requiereConfirmacionCaja: boolean;
  confirmadoPorCaja: boolean;
  fechaConfirmacionCaja?: Date | null;

  /**
   * Aprobacion del cobro de un abono de deuda.
   *
   * Estos campos los escribe el dashboard y NO estaban declarados. Como el
   * schema es `strict: true`, Mongoose los descartaba en silencio: el panel
   * creia haber aprobado el cobro y la bandera no quedaba guardada, con lo que
   * la deuda del cliente se podia descontar dos veces.
   */
  estadoAprobacionCobro?: string;
  deudaAplicada?: boolean;
  aprobadoPor?: string;
  fechaAprobacionCobro?: Date | null;

  /** Ticket excluido del flujo de caja sin anularse (abonado). */
  marcadoComoAbonado?: boolean;
  motivoMarcadoAbonado?: string;
  marcadoComoAbonadoPor?: string;
  fechaMarcadoComoAbonado?: Date | null;

  // Credito CRM
  creditoProcesado: boolean;
  creditoPinRequerido: boolean;
  creditoPinValidado: boolean;
  sucursalCreditoLibre: string | null;
  creditoLibreSucursal: boolean;

  // Descuentos / promociones
  subtotal?: number;
  subtotalOriginal?: number;
  discountAmount?: number;
  premiumDiscountApplied?: boolean;
  premiumDiscountPercent?: number;
  movimientoGratuito?: boolean;
  noAfectaCaja?: boolean;
  motivoNoAfectaCaja?: string;

  // Puntos
  puntosOtorgados: number;
  puntosCanjeados: number;

  // Arqueo / turno
  arqueado: boolean;
  fechaArqueo?: Date | null;
  turnoId?: string;
  fechaAperturaTurno?: Date | null;

  // Multimoneda
  detalleEfectivo?: IDetalleEfectivo | null;
  detallesPago?: Record<string, unknown> | null;
  paymentMethod?: string;
  paymentCurrency?: string;
  amountReceivedCurrency?: number;
  totalInSelectedCurrency?: number;
  exchangeRate?: number;
  totalPYG?: number;
  changePYG?: number;

  // Produccion / metas
  produccionSync?: Record<string, unknown> | null;
  metaPublicaRegistrada?: boolean;
  fechaMetaPublica?: Date | null;

  sucursal: string;
  sucursalId?: Types.ObjectId | null;
  legacyId?: string;
  creadoEn?: Date;
  actualizadoEn?: Date;
}

export type OrderDocument = HydratedDocument<IOrder>;

const money = { type: Number, default: 0, min: 0 };
const flag = { type: Boolean, default: false };

const detalleEfectivoSchema = new Schema<IDetalleEfectivo>(
  {
    monedaCobro: { type: String, default: 'PYG' },
    tasaCambioAplicada: { type: Number, default: 1, min: 0 },
    montoRecibidoMoneda: money,
    montoRecibidoGs: money,
    vueltoGs: money,
  },
  { _id: false },
);

const orderSchema = new Schema<IOrder, Model<IOrder>>(
  {
    ticket_id: { type: String, required: true, trim: true },
    tipoTransaccion: { type: String, enum: TIPOS_TRANSACCION, default: 'venta_comida', index: true },
    total: { type: Number, required: true, min: 0 },
    cajero: { type: String, default: 'Sistema', trim: true, index: true },
    cajeroCobro: { type: String, default: '' },
    cliente: { type: String, default: 'ocasional', index: true },
    nombreCliente: { type: String, default: 'Fisico 1', trim: true, maxlength: 140 },
    aliasReferencia: { type: String, default: '', trim: true, maxlength: 140 },
    items: { type: [orderItemSchema], default: [] },
    fecha: { type: Date, default: Date.now, index: true },
    estadoCocina: { type: String, enum: ESTADOS_COCINA, default: 'pendiente', index: true },
    observacion: { type: String, default: '', maxlength: 400 },
    metodoPago: { type: String, enum: METODOS_PAGO, default: 'Efectivo', index: true },
    estadoPago: { type: String, enum: ESTADOS_PAGO, default: 'pendiente', index: true },

    origenCuentaPendiente: flag,
    requiereConfirmacionCaja: flag,
    confirmadoPorCaja: flag,
    fechaConfirmacionCaja: { type: Date, default: null },

    // Ver el comentario en IOrder: sin declararlos, strict los descartaba.
    estadoAprobacionCobro: { type: String, default: undefined, index: true },
    deudaAplicada: { type: Boolean, default: undefined },
    aprobadoPor: { type: String, default: undefined },
    fechaAprobacionCobro: { type: Date, default: null },

    marcadoComoAbonado: { type: Boolean, default: undefined, index: true },
    motivoMarcadoAbonado: { type: String, default: undefined },
    marcadoComoAbonadoPor: { type: String, default: undefined },
    fechaMarcadoComoAbonado: { type: Date, default: null },

    creditoProcesado: flag,
    creditoPinRequerido: flag,
    creditoPinValidado: flag,
    sucursalCreditoLibre: { type: String, default: null },
    creditoLibreSucursal: flag,

    subtotal: { type: Number, default: undefined, min: 0 },
    subtotalOriginal: { type: Number, default: undefined, min: 0 },
    discountAmount: { type: Number, default: undefined, min: 0 },
    premiumDiscountApplied: { type: Boolean, default: undefined },
    premiumDiscountPercent: { type: Number, default: undefined, min: 0, max: 100 },
    movimientoGratuito: { type: Boolean, default: undefined },
    noAfectaCaja: { type: Boolean, default: undefined, index: true },
    motivoNoAfectaCaja: { type: String, default: undefined },

    puntosOtorgados: money,
    puntosCanjeados: money,

    arqueado: { type: Boolean, default: false, index: true },
    fechaArqueo: { type: Date, default: null },
    turnoId: { type: String, default: undefined, index: true },
    fechaAperturaTurno: { type: Date, default: null },

    detalleEfectivo: { type: detalleEfectivoSchema, default: null },
    detallesPago: { type: Schema.Types.Mixed, default: null },
    paymentMethod: { type: String, default: undefined },
    paymentCurrency: { type: String, default: undefined },
    amountReceivedCurrency: { type: Number, default: undefined },
    totalInSelectedCurrency: { type: Number, default: undefined },
    exchangeRate: { type: Number, default: undefined },
    totalPYG: { type: Number, default: undefined },
    changePYG: { type: Number, default: undefined },

    produccionSync: { type: Schema.Types.Mixed, default: null },
    metaPublicaRegistrada: { type: Boolean, default: undefined },
    fechaMetaPublica: { type: Date, default: null },

    sucursal: { type: String, required: true, trim: true, index: true },
    sucursalId: { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    // ID original de Firestore cuando no es un ObjectId valido (20 chars).
    legacyId: { type: String, default: undefined, sparse: true, index: true },
  },
  {
    timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' },
    versionKey: false,
    collection: 'orders',
    strict: true,
  },
);

// Indices derivados de las consultas reales del panel y la caja.
orderSchema.index({ ticket_id: 1 }, { unique: true });
orderSchema.index({ sucursal: 1, fecha: -1 });
orderSchema.index({ turnoId: 1, fecha: -1 });
orderSchema.index({ sucursal: 1, estadoPago: 1, arqueado: 1, turnoId: 1, fecha: -1 });
orderSchema.index({ cliente: 1, fecha: -1 });
orderSchema.index({ cajero: 1, fecha: -1 });
orderSchema.index({ estadoCocina: 1, sucursal: 1, fecha: -1 });
orderSchema.index({ tipoTransaccion: 1, fecha: -1 });
orderSchema.index({ estadoPago: 1, noAfectaCaja: 1, fecha: -1 });

export const Order = model<IOrder, Model<IOrder>>('Order', orderSchema);

