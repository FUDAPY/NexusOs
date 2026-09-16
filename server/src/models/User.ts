import { Schema, model, type HydratedDocument, type Model } from 'mongoose';

export const USER_ROLES = ['admin', 'supervisor', 'cajero', 'cocina', 'repartidor', 'cliente'] as const;
export type UserRol = (typeof USER_ROLES)[number];

export const USER_BENEFICIOS = ['pendiente', 'activo', 'rechazado', 'no_aplica'] as const;
export type UserEstadoBeneficios = (typeof USER_BENEFICIOS)[number];

// Valores observados en Firestore (users.tipoCliente).
export const USER_TIPOS = ['estandar', 'premium', 'vip'] as const;
export type UserTipoCliente = (typeof USER_TIPOS)[number];

/** Usuarios, personal y clientes CRM. Firestore: users. */
export interface IUser {
  nombre: string;
  email: string;
  telefono: string;
  rol: UserRol;
  tipoCliente: UserTipoCliente;
  estadoBeneficios: UserEstadoBeneficios;
  sucursal: string;

  /** Deuda acumulada del cliente CRM (Firestore: users.deuda). */
  deuda: number;
  puntos: number;

  rfid: string;
  descuentoVip: number;
  descuentoVipConfigurado: boolean;
  solicitarPinCredito: boolean;
  creditoPinConfigurado: boolean;
  /** Sucursales donde el cliente puede comprar a credito libremente. */
  sucursalesCreditoLibre: string[];
  datosCompletos: boolean;

  playTesterStatus: string;
  playTesterGroupEmail: string;
  playTesterErrorMessage: string;
  playTesterRequestedAt?: Date | null;
  playTesterProcessedAt?: Date | null;
  playStoreUrl: string;

  uid?: string;
  /**
   * Hash bcrypt de la contraseña.
   *
   * Vacio en los usuarios migrados: en Firebase las contraseñas NO vivian en
   * Firestore sino en Firebase Auth, asi que no se pudieron migrar. El primer
   * cambio de contraseña las establece (ver auth.service.ts).
   */
  passwordHash?: string;
  passwordActualizadoEn?: Date | null;
  legacyId?: string;
  creadoEn?: Date;
  actualizadoEn?: Date;
}

export type UserDocument = HydratedDocument<IUser>;

const userSchema = new Schema<IUser, Model<IUser>>(
  {
    nombre: { type: String, required: true, trim: true, maxlength: 140 },
    email: { type: String, required: true, trim: true, lowercase: true },
    telefono: { type: String, default: '', trim: true, maxlength: 40 },
    passwordHash: { type: String, default: '', select: false },
    passwordActualizadoEn: { type: Date, default: null },
    rol: { type: String, enum: USER_ROLES, default: 'cliente', index: true },
    tipoCliente: { type: String, enum: USER_TIPOS, default: 'estandar', index: true },
    estadoBeneficios: { type: String, enum: USER_BENEFICIOS, default: 'pendiente', index: true },
    sucursal: { type: String, default: 'Unificado', trim: true, index: true },

    deuda: { type: Number, default: 0 },
    puntos: { type: Number, default: 0, min: 0 },

    rfid: { type: String, default: undefined, sparse: true, index: true },
    descuentoVip: { type: Number, default: 0, min: 0, max: 100 },
    descuentoVipConfigurado: { type: Boolean, default: false },
    solicitarPinCredito: { type: Boolean, default: false },
    creditoPinConfigurado: { type: Boolean, default: false },
    sucursalesCreditoLibre: { type: [String], default: [] },
    datosCompletos: { type: Boolean, default: false },

    playTesterStatus: { type: String, default: '' },
    playTesterGroupEmail: { type: String, default: '' },
    playTesterErrorMessage: { type: String, default: '' },
    playTesterRequestedAt: { type: Date, default: null },
    playTesterProcessedAt: { type: Date, default: null },
    playStoreUrl: { type: String, default: '' },

    uid: { type: String, default: undefined, sparse: true, index: true },
    legacyId: { type: String, default: undefined, sparse: true },
  },
  {
    timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' },
    versionKey: false,
    collection: 'users',
    strict: true,
  },
);

// Espejo de firestore.indexes.json: rol + estadoBeneficios.
userSchema.index({ rol: 1, estadoBeneficios: 1 });
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ sucursal: 1, rol: 1 });
userSchema.index({ rol: 1, tipoCliente: 1 });

export const User = model<IUser, Model<IUser>>('User', userSchema);
