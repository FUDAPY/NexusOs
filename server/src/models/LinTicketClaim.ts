import { Schema, model, type HydratedDocument, type Model } from 'mongoose';

/** Canje de un LIN Ticket por un cliente. MongoDB: lin_ticket_claims. */
export interface ILinTicketClaim {
  userId: string;
  userName?: string;

  ticketId?: string;
  ticketName?: string;

  branchId?: string;
  branchName?: string;

  type?: string;
  status?: string;

  productId?: string;
  productName?: string;
  productPrice?: number;
  productImageUrl?: string;

  pointsGranted?: number;
  oneTimePerUser?: boolean;
  noAfectaCaja?: boolean;

  claimedAt?: Date;
  legacyId?: string;
}

export type LinTicketClaimDocument = HydratedDocument<ILinTicketClaim>;

const linTicketClaimSchema = new Schema<ILinTicketClaim, Model<ILinTicketClaim>>(
  {
    userId: { type: String, required: true, index: true },
    userName: { type: String, default: '' },

    ticketId: { type: String, default: '', index: true },
    ticketName: { type: String, default: '' },

    branchId: { type: String, default: '' },
    branchName: { type: String, default: '' },

    type: { type: String, default: 'free_product' },
    status: { type: String, default: 'pending_redeem', index: true },

    productId: { type: String, default: '' },
    productName: { type: String, default: '' },
    productPrice: { type: Number, default: 0 },
    productImageUrl: { type: String, default: '' },

    pointsGranted: { type: Number, default: 0 },
    oneTimePerUser: { type: Boolean, default: false },
    noAfectaCaja: { type: Boolean, default: false },

    claimedAt: { type: Date, default: null, index: true },
    legacyId: { type: String, index: true },
  },
  {
    timestamps: { createdAt: 'creadoEn', updatedAt: false },
    collection: 'lin_ticket_claims',
    strict: false,
  },
);

linTicketClaimSchema.index({ userId: 1, ticketId: 1 });

export const LinTicketClaim: Model<ILinTicketClaim> =
  model<ILinTicketClaim>('LinTicketClaim', linTicketClaimSchema);
