import { Schema, model, type HydratedDocument, type Model } from 'mongoose';


export interface IProductionBatch {
  tipoInsumo: string;
  unidad?: string;

  sucursal?: string;
  sucursalKey?: string;

  cantidadIngresada?: number;
  cantidadAcreditada?: number;

  medallonesGenerados?: number;
  panesGenerados?: number;
  papasGeneradas?: number;
  carneSalteadoGenerada?: number;
  carneLomitoGenerada?: number;
  panLomitoGenerado?: number;

  observacion?: string;
  createdBy?: string;
  createdByNombre?: string;
  createdAt?: Date;
  legacyId?: string;
}

export type ProductionBatchDocument = HydratedDocument<IProductionBatch>;

const productionBatchSchema = new Schema<IProductionBatch, Model<IProductionBatch>>(
  {
    tipoInsumo: { type: String, required: true, index: true },
    unidad: { type: String, default: 'unidades' },

    sucursal: { type: String, default: '', index: true },
    sucursalKey: { type: String, default: '', index: true },

    cantidadIngresada: { type: Number, default: 0 },
    cantidadAcreditada: { type: Number, default: 0 },

    medallonesGenerados: { type: Number, default: 0 },
    panesGenerados: { type: Number, default: 0 },
    papasGeneradas: { type: Number, default: 0 },
    carneSalteadoGenerada: { type: Number, default: 0 },
    carneLomitoGenerada: { type: Number, default: 0 },
    panLomitoGenerado: { type: Number, default: 0 },

    observacion: { type: String, default: '' },
    createdBy: { type: String, default: null },
    createdByNombre: { type: String, default: '' },
    createdAt: { type: Date, default: null, index: true },
    legacyId: { type: String, index: true },
  },
  {
    timestamps: { createdAt: 'creadoEn', updatedAt: false },
    collection: 'production_batches',
    strict: false,
  },
);

productionBatchSchema.index({ sucursalKey: 1, createdAt: -1 });

export const ProductionBatch: Model<IProductionBatch> =
  model<IProductionBatch>('ProductionBatch', productionBatchSchema);
