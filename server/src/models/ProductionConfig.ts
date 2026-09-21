import { Schema, model, type HydratedDocument, type Model } from 'mongoose';


export interface IProductionConfig {
  legacyId: string;
  sucursal?: string;
  sucursalKey?: string;

  medallonesDisponibles?: number;
  medallonesIngresados?: number;
  medallonesConsumidos?: number;

  panesDisponibles?: number;
  panesIngresados?: number;
  panesConsumidos?: number;

  papasDisponibles?: number;
  papasIngresadas?: number;
  papasConsumidos?: number;

  carneSalteadoDisponible?: number;
  carneSalteadoIngresada?: number;
  carneSalteadoConsumida?: number;

  carneLomitoDisponible?: number;
  carneLomitoIngresada?: number;
  carneLomitoConsumida?: number;

  panLomitoDisponible?: number;
  panLomitoIngresado?: number;
  panLomitoConsumido?: number;

  updatedAt?: Date;
  updatedBy?: string;
  updatedByNombre?: string;
}

export type ProductionConfigDocument = HydratedDocument<IProductionConfig>;

const productionConfigSchema = new Schema<IProductionConfig, Model<IProductionConfig>>(
  {
    legacyId: { type: String, required: true, unique: true, trim: true },
    sucursal: { type: String, default: '' },
    sucursalKey: { type: String, default: '', index: true },

    medallonesDisponibles: { type: Number, default: 0 },
    medallonesIngresados: { type: Number, default: 0 },
    medallonesConsumidos: { type: Number, default: 0 },

    panesDisponibles: { type: Number, default: 0 },
    panesIngresados: { type: Number, default: 0 },
    panesConsumidos: { type: Number, default: 0 },

    papasDisponibles: { type: Number, default: 0 },
    papasIngresadas: { type: Number, default: 0 },
    papasConsumidos: { type: Number, default: 0 },

    carneSalteadoDisponible: { type: Number, default: 0 },
    carneSalteadoIngresada: { type: Number, default: 0 },
    carneSalteadoConsumida: { type: Number, default: 0 },

    carneLomitoDisponible: { type: Number, default: 0 },
    carneLomitoIngresada: { type: Number, default: 0 },
    carneLomitoConsumida: { type: Number, default: 0 },

    panLomitoDisponible: { type: Number, default: 0 },
    panLomitoIngresado: { type: Number, default: 0 },
    panLomitoConsumido: { type: Number, default: 0 },

    updatedAt: { type: Date, default: null },
    updatedBy: { type: String, default: null },
    updatedByNombre: { type: String, default: '' },
  },
  {
    timestamps: { createdAt: 'creadoEn', updatedAt: false },
    collection: 'production_config',
    strict: false,
  },
);

export const ProductionConfig: Model<IProductionConfig> =
  model<IProductionConfig>('ProductionConfig', productionConfigSchema);
