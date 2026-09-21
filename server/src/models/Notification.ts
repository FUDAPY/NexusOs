import { Schema, model, type HydratedDocument, type Model } from 'mongoose';


export interface INotification {
  titulo?: string;
  mensaje?: string;
  autor?: string;
  rolAutor?: string;
  fecha?: Date | null;

  totalTokens?: number;
  pushEnviados?: number;
  pushFallidos?: number;
  vistoPor?: string[];

  legacyId?: string;
}

export type NotificationDocument = HydratedDocument<INotification>;

const notificationSchema = new Schema<INotification, Model<INotification>>(
  {
    titulo: { type: String, default: '' },
    mensaje: { type: String, default: '' },
    autor: { type: String, default: '' },
    rolAutor: { type: String, default: '' },
    fecha: { type: Date, default: null, index: true },

    totalTokens: { type: Number, default: 0 },
    pushEnviados: { type: Number, default: 0 },
    pushFallidos: { type: Number, default: 0 },
    vistoPor: { type: [String], default: [] },

    legacyId: { type: String, index: true },
  },
  {
    timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' },
    collection: 'notifications',
    strict: false,
  },
);

export const Notification: Model<INotification> = model<INotification>('Notification', notificationSchema);
