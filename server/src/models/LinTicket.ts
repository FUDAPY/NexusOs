import { Schema, model, type HydratedDocument, type Model } from 'mongoose';

/**
 * LIN Ticket: beneficio canjeable por puntos (producto gratis, descuento...).
 * MongoDB: lin_tickets.
 */
export interface ILinTicket {
  name: string;
  title?: string;
  description?: string;
  conditions?: string;

  type?: string;
  benefitType?: string;

  points?: number;
  pointsValue?: number;

  productId?: string;
  productName?: string;
  productPrice?: number;
  productCategory?: string;
  productImageUrl?: string;
  imageUrl?: string;

  active?: boolean;
  oneTimePerUser?: boolean;
  appliesToAllBranches?: boolean;
  branchId?: string;
  branchName?: string;

  startDate?: string;
  endDate?: string;

  createdAt?: Date;
  updatedAt?: Date;
  legacyId?: string;
}

export type LinTicketDocument = HydratedDocument<ILinTicket>;

const linTicketSchema = new Schema<ILinTicket, Model<ILinTicket>>(
  {
    name: { type: String, required: true, trim: true },
    title: { type: String, default: '' },
    description: { type: String, default: '' },
    conditions: { type: String, default: '' },

    type: { type: String, default: 'free_product', index: true },
    benefitType: { type: String, default: '' },

    points: { type: Number, default: 0 },
    pointsValue: { type: Number, default: 0 },

    productId: { type: String, default: '', index: true },
    productName: { type: String, default: '' },
    productPrice: { type: Number, default: 0 },
    productCategory: { type: String, default: '' },
    productImageUrl: { type: String, default: '' },
    imageUrl: { type: String, default: '' },

    active: { type: Boolean, default: true, index: true },
    oneTimePerUser: { type: Boolean, default: false },
    appliesToAllBranches: { type: Boolean, default: true },
    branchId: { type: String, default: 'all' },
    branchName: { type: String, default: '' },

    startDate: { type: String, default: '' },
    endDate: { type: String, default: '' },

    createdAt: { type: Date, default: null },
    updatedAt: { type: Date, default: null },
    legacyId: { type: String, index: true },
  },
  {
    timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' },
    collection: 'lin_tickets',
    strict: false,
  },
);

linTicketSchema.index({ active: 1, type: 1 });

export const LinTicket: Model<ILinTicket> = model<ILinTicket>('LinTicket', linTicketSchema);
