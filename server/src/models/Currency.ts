import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

export const CURRENCY_CODES = ['PYG', 'USD', 'ARS', 'BRL'] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];


export interface ICurrency {
  codigo: CurrencyCode;
  nombre: string;
  simbolo: string;
  esBase: boolean;
  tasaCompra: number;
  tasaVenta: number;
  decimales: number;
  activa: boolean;
  
  origen?: string;
  actualizadoPor?: Types.ObjectId | null;
  actualizadoEn: Date;
  creadoEn: Date;
}

export type CurrencyDocument = HydratedDocument<ICurrency>;

const currencySchema = new Schema<ICurrency, Model<ICurrency>>(
  {
    codigo: { type: String, enum: CURRENCY_CODES, required: true, unique: true },
    nombre: { type: String, required: true, trim: true },
    simbolo: { type: String, required: true, trim: true, maxlength: 8 },
    esBase: { type: Boolean, default: false },
    // Tasa expresada en unidades de la moneda base (PYG) por 1 unidad de esta divisa.
    tasaCompra: { type: Number, required: true, min: 0 },
    tasaVenta: { type: Number, required: true, min: 0 },
    decimales: { type: Number, default: 2, min: 0, max: 4 },
    activa: { type: Boolean, default: true, index: true },
    origen: { type: String, default: undefined },
    actualizadoPor: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' },
    versionKey: false,
    collection: 'currencies',
    strict: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

currencySchema.index({ activa: 1, codigo: 1 });


currencySchema.virtual('spread').get(function spread(this: ICurrency): number {
  if (this.tasaCompra <= 0) return 0;
  return Number((((this.tasaVenta - this.tasaCompra) / this.tasaCompra) * 100).toFixed(2));
});

export const Currency = model<ICurrency, Model<ICurrency>>('Currency', currencySchema);
