import { Schema, model, type HydratedDocument, type Model } from 'mongoose';


export interface ISetting {
  legacyId: string;

  codigoRfidAnulacion?: string;
  creditoMaximoCliente?: number;
  descuentoEfectivoAppPct?: number;
  divisas?: Record<string, unknown>;
  fechaActualizacionCambio?: number;
  vapidPublicKey?: string;
}

export type SettingDocument = HydratedDocument<ISetting>;

const settingSchema = new Schema<ISetting, Model<ISetting>>(
  {
    legacyId: { type: String, required: true, unique: true, trim: true },

    codigoRfidAnulacion: { type: String, default: '' },
    creditoMaximoCliente: { type: Number, default: 0 },
    descuentoEfectivoAppPct: { type: Number, default: 0 },
    divisas: { type: Schema.Types.Mixed, default: {} },
    fechaActualizacionCambio: { type: Number, default: 0 },
    vapidPublicKey: { type: String, default: '' },
  },
  {
    timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' },
    collection: 'settings',
    strict: false,
  },
);

export const Setting: Model<ISetting> = model<ISetting>('Setting', settingSchema);
