import { Schema, model, type HydratedDocument, type Model } from 'mongoose';

/**
 * PIN de credito de un cliente (autorizacion para fiado).
 * MongoDB: credit_pins. Un documento por cliente.
 */
export interface ICreditPin {
  clienteId: string;
  pin?: string;

  activo?: boolean;
  intentosFallidos?: number;
  bloqueadoHasta?: Date | null;

  creadoEn?: Date;
  actualizadoEn?: Date;
  legacyId?: string;
}

export type CreditPinDocument = HydratedDocument<ICreditPin>;

const creditPinSchema = new Schema<ICreditPin, Model<ICreditPin>>(
  {
    clienteId: { type: String, required: true, unique: true, index: true },
    pin: { type: String, default: '' },

    activo: { type: Boolean, default: true },
    intentosFallidos: { type: Number, default: 0 },
    bloqueadoHasta: { type: Date, default: null },

    creadoEn: { type: Date, default: null },
    actualizadoEn: { type: Date, default: null },
    legacyId: { type: String, index: true },
  },
  {
    timestamps: false,
    collection: 'credit_pins',
    strict: false,
  },
);

export const CreditPin: Model<ICreditPin> = model<ICreditPin>('CreditPin', creditPinSchema);
