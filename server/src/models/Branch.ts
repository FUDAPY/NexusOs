import { Schema, model, type HydratedDocument, type Model } from 'mongoose';

/** Sucursal. Firestore: branches. Los campos replican el documento legado. */
export interface IBranch {
  nombre: string;
  ruc: string;
  telefono: string;
  direccion: string;
  mapsUrl: string;
  imagenLocalUrl: string;
  mensajePie: string;

  temaApp: string;
  iconoTema: string;
  colorPrincipal: string;
  colorAcento: string;
  /** Categorias habilitadas para la app de cliente (vacio = todas). */
  categoriasActivas: string[];

  controlHorarioPedidos: boolean;
  horarioApertura: string;
  horarioCierre: string;

  legacyId?: string;
  creadoEn?: Date;
  actualizadoEn?: Date;
}

export type BranchDocument = HydratedDocument<IBranch>;

const branchSchema = new Schema<IBranch, Model<IBranch>>(
  {
    nombre: { type: String, required: true, trim: true, maxlength: 140 },
    ruc: { type: String, default: '' },
    telefono: { type: String, default: '' },
    direccion: { type: String, default: '', maxlength: 220 },
    mapsUrl: { type: String, default: '' },
    imagenLocalUrl: { type: String, default: '' },
    mensajePie: { type: String, default: '' },

    temaApp: { type: String, default: 'restaurante' },
    iconoTema: { type: String, default: 'fa-store' },
    colorPrincipal: { type: String, default: '#ffffff' },
    colorAcento: { type: String, default: '#ff0000' },
    categoriasActivas: { type: [String], default: [] },

    controlHorarioPedidos: { type: Boolean, default: false },
    horarioApertura: { type: String, default: '08:00' },
    horarioCierre: { type: String, default: '23:00' },

    legacyId: { type: String, default: undefined, sparse: true },
  },
  {
    timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' },
    versionKey: false,
    collection: 'branches',
    strict: true,
  },
);

branchSchema.index({ nombre: 1 }, { unique: true });

export const Branch = model<IBranch, Model<IBranch>>('Branch', branchSchema);
