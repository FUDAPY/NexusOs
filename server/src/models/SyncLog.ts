import { Schema, model, type HydratedDocument, type Model } from 'mongoose';


export interface ISyncLog {
  coleccion?: string;
  tipo?: string;
  sucursal?: string;
  usuario?: string;
  detalle?: Record<string, unknown>;
  timestamp?: Date;
  legacyId?: string;
}

export type SyncLogDocument = HydratedDocument<ISyncLog>;

const syncLogSchema = new Schema<ISyncLog, Model<ISyncLog>>(
  {
    coleccion: { type: String, default: '', index: true },
    tipo: { type: String, default: '', index: true },
    sucursal: { type: String, default: '', index: true },
    usuario: { type: String, default: '' },
    detalle: { type: Schema.Types.Mixed, default: {} },
    timestamp: { type: Date, default: null, index: true },
    legacyId: { type: String, index: true },
  },
  {
    timestamps: { createdAt: 'creadoEn', updatedAt: false },
    collection: 'sync_logs',
    strict: false,
  },
);

syncLogSchema.index({ sucursal: 1, timestamp: -1 });

export const SyncLog: Model<ISyncLog> = model<ISyncLog>('SyncLog', syncLogSchema);
