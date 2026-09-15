import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

// Valores observados en Firestore (cashFlows.estadoTurno).
export const SHIFT_ESTADOS = ['abierto', 'cerrado', 'forzado'] as const;
export type ShiftEstado = (typeof SHIFT_ESTADOS)[number];

/**
 * Turno de caja. Firestore: cashFlows.
 * Los totales del turno son campos planos (no subdocumento) para preservar la paridad 1:1.
 */
export interface ICashShift {
  turnoId: string;
  estadoTurno: ShiftEstado;

  sucursal: string;
  sucursalId?: Types.ObjectId | null;
  sucursalesActivas: string[];

  efectivo: number;
  tarjetaPOS: number;
  transferencia: number;
  credito: number;
  ventaTotalBruta: number;
  /** Fondo fijo con el que el cajero abrio el turno. Suma al esperado en efectivo. */
  fondoInicial?: number;

  totalProductos: number;
  totalTickets: number;
  totalTicketsFlujo: number;
  totalTicketsPagados: number;
  totalTicketsPendientes: number;

  fechaApertura?: Date | null;
  fechaOperativa?: Date | null;
  closedAt?: Date | null;
  updatedAt?: Date | null;

  origen: string;
  version: number;

  legacyId?: string;
  creadoEn?: Date;
}

export type CashShiftDocument = HydratedDocument<ICashShift>;

const money = { type: Number, default: 0, min: 0 };
const counter = { type: Number, default: 0, min: 0 };

const cashShiftSchema = new Schema<ICashShift, Model<ICashShift>>(
  {
    turnoId: { type: String, required: true, trim: true },
    estadoTurno: { type: String, enum: SHIFT_ESTADOS, default: 'abierto', index: true },

    sucursal: { type: String, required: true, trim: true, index: true },
    sucursalId: { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    sucursalesActivas: { type: [String], default: [] },

    efectivo: money,
    fondoInicial: money,
    tarjetaPOS: money,
    transferencia: money,
    credito: money,
    ventaTotalBruta: money,

    totalProductos: counter,
    totalTickets: counter,
    totalTicketsFlujo: counter,
    totalTicketsPagados: counter,
    totalTicketsPendientes: counter,

    fechaApertura: { type: Date, default: null, index: true },
    fechaOperativa: { type: Date, default: null, index: true },
    closedAt: { type: Date, default: null, index: true },
    updatedAt: { type: Date, default: null },

    origen: { type: String, default: 'pos' },
    version: { type: Number, default: 1 },

    legacyId: { type: String, default: undefined, sparse: true, index: true },
  },
  {
    timestamps: { createdAt: 'creadoEn', updatedAt: false },
    versionKey: false,
    collection: 'cash_shifts',
    strict: true,
  },
);

cashShiftSchema.index({ turnoId: 1 }, { unique: true });
// Espejo de firestore.indexes.json (cashFlows): estadoTurno + sucursalId + updatedAt.
cashShiftSchema.index({ estadoTurno: 1, sucursalId: 1, updatedAt: -1 });
// Un solo turno abierto por sucursal.
cashShiftSchema.index(
  { sucursal: 1, estadoTurno: 1 },
  { unique: true, partialFilterExpression: { estadoTurno: 'abierto' } },
);

export const CashShift = model<ICashShift, Model<ICashShift>>('CashShift', cashShiftSchema);
