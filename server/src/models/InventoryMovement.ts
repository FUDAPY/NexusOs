import { Schema, model, type HydratedDocument, type Model } from 'mongoose';


export interface IInventoryMovement {
  productoId: string;
  nombreProducto?: string;

  sucursal?: string;
  sucursalId?: string | null;
  sucursalNombre?: string;

  tipo: string;
  motivo?: string;

  cantidad: number;
  cantidadAnterior?: number;
  cantidadResultante?: number;

  ventaId?: string;
  cajaId?: string;
  turnoId?: string;

  usuario?: string;
  usuarioId?: string | null;

  fecha?: Date;
  estado?: string;
  idempotencyKey?: string;
  legacyId?: string;
}

export type InventoryMovementDocument = HydratedDocument<IInventoryMovement>;

const inventoryMovementSchema = new Schema<IInventoryMovement, Model<IInventoryMovement>>(
  {
    productoId: { type: String, required: true, index: true },
    nombreProducto: { type: String, default: '' },

    sucursal: { type: String, default: '', index: true },
    sucursalId: { type: String, default: null },
    sucursalNombre: { type: String, default: '' },

    tipo: { type: String, required: true, index: true },
    motivo: { type: String, default: '' },

    cantidad: { type: Number, required: true },
    cantidadAnterior: { type: Number, default: 0 },
    cantidadResultante: { type: Number, default: 0 },

    ventaId: { type: String, default: null, index: true },
    cajaId: { type: String, default: null },
    turnoId: { type: String, default: null, index: true },

    usuario: { type: String, default: '' },
    usuarioId: { type: String, default: null },

    fecha: { type: Date, default: null, index: true },
    estado: { type: String, default: 'aplicado' },
    idempotencyKey: { type: String, default: null },
    legacyId: { type: String, index: true },
  },
  {
    timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' },
    collection: 'inventory_movements',
    strict: false,
  },
);


inventoryMovementSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
inventoryMovementSchema.index({ productoId: 1, fecha: -1 });

export const InventoryMovement: Model<IInventoryMovement> =
  model<IInventoryMovement>('InventoryMovement', inventoryMovementSchema);
