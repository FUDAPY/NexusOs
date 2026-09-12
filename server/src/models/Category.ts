import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

/** Categorias del menu (POS/KDS). Firestore: categories. */
export interface ICategory {
  nombre: string;
  slug: string;
  descripcion: string;
  icono: string;
  color: string;
  orden: number;
  sucursal: string;
  sucursalId?: Types.ObjectId | null;
  padreId?: Types.ObjectId | null;
  visibleEnPos: boolean;
  estado: 'activa' | 'inactiva';
  /** Trazabilidad cuando el registro proviene de la migracion. */
  origen?: string;
  creadoEn: Date;
  actualizadoEn: Date;
}

export type CategoryDocument = HydratedDocument<ICategory>;

const toSlug = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const categorySchema = new Schema<ICategory, Model<ICategory>>(
  {
    nombre: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, trim: true, lowercase: true, index: true },
    descripcion: { type: String, default: '', maxlength: 300 },
    icono: { type: String, default: 'fa-utensils' },
    color: { type: String, default: '#0f172a' },
    orden: { type: Number, default: 0 },
    sucursal: { type: String, default: 'Unificado', trim: true, index: true },
    sucursalId: { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    padreId: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    visibleEnPos: { type: Boolean, default: true },
    estado: { type: String, enum: ['activa', 'inactiva'], default: 'activa', index: true },
    origen: { type: String, default: undefined },
  },
  {
    timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' },
    versionKey: false,
    collection: 'categories',
    strict: true,
  },
);

// Deriva el slug cuando no se provee explicitamente.
categorySchema.pre('validate', function ensureSlug(next) {
  if (!this.slug && this.nombre) this.slug = toSlug(this.nombre);
  next();
});

categorySchema.index({ sucursalId: 1, estado: 1, orden: 1 });

export const Category = model<ICategory, Model<ICategory>>('Category', categorySchema);
