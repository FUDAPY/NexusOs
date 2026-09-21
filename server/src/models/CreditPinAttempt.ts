import { Schema, model, type HydratedDocument, type Model } from 'mongoose';


export interface ICreditPinAttempt {
  clienteId?: string;
  userId?: string;
  exitoso?: boolean;
  motivo?: string;
  ip?: string;
  fecha?: Date;
  legacyId?: string;
}

export type CreditPinAttemptDocument = HydratedDocument<ICreditPinAttempt>;

const creditPinAttemptSchema = new Schema<ICreditPinAttempt, Model<ICreditPinAttempt>>(
  {
    clienteId: { type: String, default: null, index: true },
    userId: { type: String, default: null, index: true },
    exitoso: { type: Boolean, default: false },
    motivo: { type: String, default: '' },
    ip: { type: String, default: '' },
    fecha: { type: Date, default: null, index: true },
    legacyId: { type: String, index: true },
  },
  {
    timestamps: { createdAt: 'creadoEn', updatedAt: false },
    collection: 'credit_pin_attempts',
    strict: false,
  },
);

creditPinAttemptSchema.index({ userId: 1, fecha: -1 });

export const CreditPinAttempt: Model<ICreditPinAttempt> =
  model<ICreditPinAttempt>('CreditPinAttempt', creditPinAttemptSchema);
