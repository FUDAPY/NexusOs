import { Schema, model, type HydratedDocument, type Model } from 'mongoose';

export const AUDIT_SEVERIDADES = ['info', 'warning', 'error', 'critical'] as const;
export type AuditSeveridad = (typeof AUDIT_SEVERIDADES)[number];

/** Datos libres de la incidencia (se tipan en la capa de servicio). */
export type AuditPayload = Record<string, unknown>;

/**
 * Registro inalterable (append-only). Firestore: `auditoria` + `systemAlerts`.
 * Unifica transacciones criticas y tickets internos de soporte en una sola coleccion.
 */
export interface IAuditLog {
  /** Discriminador: anulacion_ticket, correccion_cierre_caja, ticket_soporte, ... */
  tipo: string;
  subtipo: string;
  origen: string;

  fecha: Date;
  timestamp: Date;

  adminId: string;
  adminNombre: string;
  clienteId: string;
  autorizadoPor: string;

  ticketId: string;
  ventaId: string;
  aliasReferencia: string;
  nombreCliente: string;
  estadoPago: string;
  metodoPago: string;
  motivo: string;

  totalAntes: number;
  totalDespues: number;

  item: AuditPayload | null;
  itemsOriginales: AuditPayload[];
  itemsRestantes: AuditPayload[];
  autorizacionRfid: AuditPayload | null;

  sucursal: string;

  // Tickets internos de soporte (ex coleccion systemAlerts).
  mensaje: string;
  nivel: string;
  estado: string;
  detalle: AuditPayload | null;
  creadoPor: string;
  creadoPorRol: string;
  resueltoPor: string;
  resueltoPorNombre: string;
  resueltoAt?: Date | null;

  legacyId?: string;
  creadoEn?: Date;
}

export type AuditLogDocument = HydratedDocument<IAuditLog>;

const auditLogSchema = new Schema<IAuditLog, Model<IAuditLog>>(
  {
    tipo: { type: String, required: true, trim: true, maxlength: 80, index: true },
    subtipo: { type: String, default: '', index: true },
    origen: { type: String, default: '', index: true },

    fecha: { type: Date, default: Date.now, index: true },
    timestamp: { type: Date, default: Date.now, index: true },

    adminId: { type: String, default: '', index: true },
    adminNombre: { type: String, default: '', maxlength: 140 },
    clienteId: { type: String, default: '', index: true },
    autorizadoPor: { type: String, default: '' },

    ticketId: { type: String, default: '', index: true },
    ventaId: { type: String, default: '', index: true },
    aliasReferencia: { type: String, default: '', maxlength: 140 },
    nombreCliente: { type: String, default: '', maxlength: 140 },
    estadoPago: { type: String, default: '', index: true },
    metodoPago: { type: String, default: '' },
    motivo: { type: String, default: '', maxlength: 400 },

    totalAntes: { type: Number, default: 0 },
    totalDespues: { type: Number, default: 0 },

    item: { type: Schema.Types.Mixed, default: null },
    // Mixed en lugar de [Mixed]: evita la incompatibilidad de tipos de Mongoose con arrays de Mixed.
    itemsOriginales: { type: Schema.Types.Mixed, default: () => [] },
    itemsRestantes: { type: Schema.Types.Mixed, default: () => [] },
    autorizacionRfid: { type: Schema.Types.Mixed, default: null },

    sucursal: { type: String, default: 'Unificado', index: true },

    mensaje: { type: String, default: '', maxlength: 500 },
    nivel: { type: String, default: '', index: true },
    estado: { type: String, default: '', index: true },
    detalle: { type: Schema.Types.Mixed, default: null },
    creadoPor: { type: String, default: '' },
    creadoPorRol: { type: String, default: '' },
    resueltoPor: { type: String, default: '' },
    resueltoPorNombre: { type: String, default: '' },
    resueltoAt: { type: Date, default: null },

    legacyId: { type: String, default: undefined, sparse: true, index: true },
  },
  {
    timestamps: { createdAt: 'creadoEn', updatedAt: false },
    versionKey: false,
    collection: 'audit_logs',
    // strict (no 'throw'): el legado puede traer campos nuevos sin romper la escritura.
    strict: true,
  },
);

// Indices espejo de firestore.indexes.json (auditoria): tipo + fecha desc.
auditLogSchema.index({ tipo: 1, fecha: -1 });
auditLogSchema.index({ sucursal: 1, fecha: -1 });
auditLogSchema.index({ adminId: 1, fecha: -1 });
auditLogSchema.index({ ticketId: 1, fecha: -1 });
auditLogSchema.index({ nivel: 1, estado: 1, fecha: -1 });
// Retencion de 5 anios.
auditLogSchema.index({ fecha: 1, tipo: 1 }, { expireAfterSeconds: 157_680_000 });

// Append-only: bloquea updates y borrados.
const blockMutation = (next: (error?: Error) => void): void => {
  next(new Error('audit_logs es append-only: updates y deletes no permitidos'));
};

auditLogSchema.pre('updateOne', function guardUpdateOne(next) {
  blockMutation(next);
});
auditLogSchema.pre('updateMany', function guardUpdateMany(next) {
  blockMutation(next);
});
auditLogSchema.pre('findOneAndUpdate', function guardFindOneAndUpdate(next) {
  blockMutation(next);
});
auditLogSchema.pre('deleteOne', function guardDeleteOne(next) {
  blockMutation(next);
});
auditLogSchema.pre('deleteMany', function guardDeleteMany(next) {
  blockMutation(next);
});

export const AuditLog = model<IAuditLog, Model<IAuditLog>>('AuditLog', auditLogSchema);
