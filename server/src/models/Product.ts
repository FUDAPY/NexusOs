import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

export const PRODUCT_ESTADOS = ['Activo', 'Inactivo'] as const;
export type ProductEstado = (typeof PRODUCT_ESTADOS)[number];

export const PRODUCT_VISIBILIDAD = ['Unificado', 'Sucursal'] as const;
export type ProductVisibilidad = (typeof PRODUCT_VISIBILIDAD)[number];

export interface IProduct {
  codigo?: string;
  nombre: string;
  precio: number;
  precioCosto: number;
  categoria: string;
  categoriaId?: Types.ObjectId | null;
  icono: string;
  imagen?: string;
  imagenes: string[];
  estado: ProductEstado;
  
  sucursal: string;
  sucursalNombre: string;
  sucursalId?: Types.ObjectId | null;
  visibilidad: ProductVisibilidad;

  
  controlado: boolean;
  stock: number;
  stockMinimo: number;
  agotado: boolean;

  descuento: number;
  promocionBogo: boolean;
  permiteProductoGratis: boolean;

  usaProduccionCarne: boolean;
  medallonesPorUnidad: number;
  usaProduccionPan: boolean;
  panesPorUnidad: number;
  usaProduccionPapa: boolean;
  papasPorUnidad: number;
  usaProduccionCarneSalteado: boolean;
  carneSalteadoPorUnidad: number;
  usaProduccionCarneLomito: boolean;
  carneLomitoPorUnidad: number;
  usaProduccionPanLomito: boolean;
  panLomitoPorUnidad: number;

  puntosCanje: number;
  creadoEn: Date;
  actualizadoEn: Date;
}

export type ProductDocument = HydratedDocument<IProduct>;

const nonNegativeInt = { type: Number, default: 0, min: 0 };

const productSchema = new Schema<IProduct, Model<IProduct>>(
  {
    codigo: { type: String, trim: true, sparse: true, index: true },
    nombre: { type: String, required: true, trim: true, maxlength: 160 },
    precio: { type: Number, required: true, min: 0 },
    precioCosto: { type: Number, default: 0, min: 0 },
    categoria: { type: String, default: 'Sin Categoria', trim: true, index: true },
    categoriaId: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    icono: { type: String, default: 'fa-box' },
    imagen: { type: String, default: '' },
    imagenes: { type: [String], default: [] },
    estado: { type: String, enum: PRODUCT_ESTADOS, default: 'Activo', index: true },

    sucursal: { type: String, default: 'Unificado', trim: true, index: true },
    sucursalNombre: { type: String, default: 'Unificado', trim: true },
    sucursalId: { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    visibilidad: { type: String, enum: PRODUCT_VISIBILIDAD, default: 'Unificado' },

    controlado: { type: Boolean, default: false },
    stock: nonNegativeInt,
    stockMinimo: nonNegativeInt,
    agotado: { type: Boolean, default: false, index: true },

    descuento: { type: Number, default: 0, min: 0, max: 100 },
    promocionBogo: { type: Boolean, default: false },
    permiteProductoGratis: { type: Boolean, default: false },

    usaProduccionCarne: { type: Boolean, default: false },
    medallonesPorUnidad: nonNegativeInt,
    usaProduccionPan: { type: Boolean, default: false },
    panesPorUnidad: nonNegativeInt,
    usaProduccionPapa: { type: Boolean, default: false },
    papasPorUnidad: nonNegativeInt,
    usaProduccionCarneSalteado: { type: Boolean, default: false },
    carneSalteadoPorUnidad: nonNegativeInt,
    usaProduccionCarneLomito: { type: Boolean, default: false },
    carneLomitoPorUnidad: nonNegativeInt,
    usaProduccionPanLomito: { type: Boolean, default: false },
    panLomitoPorUnidad: nonNegativeInt,

    puntosCanje: nonNegativeInt,
  },
  {
    timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' },
    versionKey: false,
    collection: 'products',
  },
);

// Regla operativa del POS: solo los productos controlados con stock 0 se marcan Agotado.
productSchema.pre('save', function syncAgotado(next) {
  this.agotado = this.controlado === true && this.stock <= 0;
  next();
});

productSchema.index({ sucursalId: 1, estado: 1, categoria: 1 });
productSchema.index({ sucursal: 1, estado: 1, categoria: 1 });
productSchema.index({ estado: 1, agotado: 1, actualizadoEn: -1 });
productSchema.index({ nombre: 'text', codigo: 'text' });

export const Product = model<IProduct, Model<IProduct>>('Product', productSchema);
