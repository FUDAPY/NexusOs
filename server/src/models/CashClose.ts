import { Schema, model, type HydratedDocument, type Model } from 'mongoose';

/**
 * Cierre de caja. MongoDB: cash_closes (316 docs).
 *
 * strict: false a proposito. Los documentos ya existen y tienen subdocumentos
 * completos (declaracion, sistema, productosVendidos) que conviene preservar
 * tal cual. Con strict: true Mongoose DESCARTARIA en silencio todo campo no
 * declarado en el esquema.
 */
export interface ICashClose {
  turnoId?: string;
  sucursal: string;
  sucursalId?: string | null;

  cajeroId?: string | null;
  cajero?: string;

  fechaApertura?: Date;
  fechaAperturaTexto?: string;
  fechaCierre?: Date;
  fechaCierreTexto?: string;
  fechaOperacionKey?: string;
  fechaCierreKey?: string;

  fondoInicial?: number;

  
  declaracion?: Record<string, unknown>;
  sistema?: Record<string, unknown>;
  productosVendidos?: Record<string, unknown>;
  resumenFinanciero?: Record<string, unknown>;

  ticketsContados?: number;
  ticketsTurnoIds?: string[];
  turnosIncluidos?: string[];

  htmlTicket?: string;
  versionEsquemaFinanciero?: number;

  cierreForzado?: boolean;
  motivoCierreForzado?: string;
  forzadoPor?: string;
  forzadoPorId?: string;

  creadoEn?: Date;
  legacyId?: string;
}

export type CashCloseDocument = HydratedDocument<ICashClose>;

const cashCloseSchema = new Schema<ICashClose, Model<ICashClose>>(
  {
    turnoId: { type: String, trim: true },
    sucursal: { type: String, required: true, trim: true, index: true },

    cajeroId: { type: String, default: null },
    cajero: { type: String, default: '' },

    fechaApertura: { type: Date, default: null },
    fechaAperturaTexto: { type: String, default: '' },
    fechaCierre: { type: Date, default: null, index: true },
    fechaCierreTexto: { type: String, default: '' },
    fechaOperacionKey: { type: String, default: '', index: true },
    fechaCierreKey: { type: String, default: '', index: true },

    fondoInicial: { type: Number, default: 0 },

    declaracion: { type: Schema.Types.Mixed, default: {} },
    sistema: { type: Schema.Types.Mixed, default: {} },
    productosVendidos: { type: Schema.Types.Mixed, default: {} },
    resumenFinanciero: { type: Schema.Types.Mixed, default: {} },

    ticketsContados: { type: Number, default: 0 },
    ticketsTurnoIds: { type: [String], default: [] },
    turnosIncluidos: { type: [String], default: [] },

    htmlTicket: { type: String, default: '' },
    versionEsquemaFinanciero: { type: Number, default: 1 },

    cierreForzado: { type: Boolean, default: false },
    motivoCierreForzado: { type: String, default: '' },
    forzadoPor: { type: String, default: '' },
    forzadoPorId: { type: String, default: '' },

    creadoEn: { type: Date, default: null },
    legacyId: { type: String, index: true },
  },
  {
    timestamps: { createdAt: 'creadoEn', updatedAt: 'actualizadoEn' },
    collection: 'cash_closes',
    strict: false,
  },
);

cashCloseSchema.index({ turnoId: 1 }, { unique: true, sparse: true });
cashCloseSchema.index({ sucursal: 1, fechaCierre: -1 });

export const CashClose: Model<ICashClose> = model<ICashClose>('CashClose', cashCloseSchema);
