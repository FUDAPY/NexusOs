import { Schema, model, type HydratedDocument, type Model } from 'mongoose';

/**
 * Meta publica por sucursal y mes. MongoDB: public_goals (3 docs, 166 campos).
 *
 * Se declaran solo los campos que usa metas-publicas.html y los indices.
 * El resto del documento (los 166 campos) se conserva gracias a strict: false.
 */
export interface IPublicGoal {
  sucursal?: string;
  sucursalKey?: string;
  month?: string;

  monthlyGoal?: number;
  monthlyTotal?: number;
  salesCount?: number;

  source?: string;
  updatedAt?: Date;
  legacyId?: string;
}

export type PublicGoalDocument = HydratedDocument<IPublicGoal>;

const publicGoalSchema = new Schema<IPublicGoal, Model<IPublicGoal>>(
  {
    sucursal: { type: String, default: '', index: true },
    sucursalKey: { type: String, default: '', index: true },
    month: { type: String, default: '', index: true },

    monthlyGoal: { type: Number, default: 0 },
    monthlyTotal: { type: Number, default: 0 },
    salesCount: { type: Number, default: 0 },

    source: { type: String, default: '' },
    updatedAt: { type: Date, default: null },
    legacyId: { type: String, index: true },
  },
  {
    timestamps: { createdAt: 'creadoEn', updatedAt: false },
    collection: 'public_goals',
    strict: false,
  },
);

publicGoalSchema.index({ sucursalKey: 1, month: -1 });

export const PublicGoal: Model<IPublicGoal> = model<IPublicGoal>('PublicGoal', publicGoalSchema);
