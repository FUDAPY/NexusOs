import { Schema, model, type HydratedDocument, type Model } from 'mongoose';


export interface ISupportAlert {
  tipo: string;
  nivel?: string;
  origen?: string;
  mensaje?: string;
  detalle?: Record<string, unknown>;

  estado?: string;
  sucursal?: string;

  creadoAt?: Date;
  creadoPor?: string;
  creadoPorRol?: string;

  resueltoAt?: Date | null;
  resueltoPor?: string;
  resueltoPorNombre?: string;

  legacyId?: string;
}

export type SupportAlertDocument = HydratedDocument<ISupportAlert>;

const supportAlertSchema = new Schema<ISupportAlert, Model<ISupportAlert>>(
  {
    tipo: { type: String, default: 'general', index: true },
    nivel: { type: String, default: 'warning' },
    origen: { type: String, default: '' },
    mensaje: { type: String, default: '' },
    detalle: { type: Schema.Types.Mixed, default: {} },

    estado: { type: String, default: 'abierta', index: true },
    sucursal: { type: String, default: 'Todas' },

    creadoAt: { type: Date, default: null },
    creadoPor: { type: String, default: null },
    creadoPorRol: { type: String, default: '' },

    resueltoAt: { type: Date, default: null },
    resueltoPor: { type: String, default: null },
    resueltoPorNombre: { type: String, default: '' },

    legacyId: { type: String, index: true },
  },
  {
    timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' },
    collection: 'support_alerts',
    strict: false,
  },
);

supportAlertSchema.index({ estado: 1, creadoAt: -1 });

export const SupportAlert: Model<ISupportAlert> = model<ISupportAlert>('SupportAlert', supportAlertSchema);
