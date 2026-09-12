import type { ClientSession } from 'mongoose';
import { AuditLog, type AuditPayload } from '../models/AuditLog.js';

export interface AuditInput {
  tipo: string;
  subtipo?: string;
  origen?: string;
  motivo?: string;
  mensaje?: string;
  nivel?: string;
  estado?: string;
  sucursal?: string;

  adminId?: string;
  adminNombre?: string;
  clienteId?: string;

  ticketId?: string;
  ventaId?: string;
  aliasReferencia?: string;
  nombreCliente?: string;
  estadoPago?: string;
  metodoPago?: string;

  totalAntes?: number;
  totalDespues?: number;

  item?: AuditPayload | null;
  itemsOriginales?: AuditPayload[];
  itemsRestantes?: AuditPayload[];
  autorizacionRfid?: AuditPayload | null;

  detalle?: AuditPayload | null;
}

/** Escribe un registro append-only; acepta sesion para participar de la transaccion en curso. */
export const recordAudit = async (
  input: AuditInput,
  session?: ClientSession | null,
): Promise<void> => {
  const [doc] = await AuditLog.create(
    [
      {
        tipo: input.tipo,
        subtipo: input.subtipo ?? '',
        origen: input.origen ?? 'api',
        motivo: input.motivo ?? '',
        mensaje: input.mensaje ?? '',
        nivel: input.nivel ?? 'info',
        estado: input.estado ?? '',
        sucursal: input.sucursal ?? 'Unificado',

        adminId: input.adminId ?? '',
        adminNombre: input.adminNombre ?? 'Sistema',
        clienteId: input.clienteId ?? '',

        ticketId: input.ticketId ?? '',
        ventaId: input.ventaId ?? '',
        aliasReferencia: input.aliasReferencia ?? '',
        nombreCliente: input.nombreCliente ?? '',
        estadoPago: input.estadoPago ?? '',
        metodoPago: input.metodoPago ?? '',

        totalAntes: input.totalAntes ?? 0,
        totalDespues: input.totalDespues ?? 0,

        item: input.item ?? null,
        itemsOriginales: input.itemsOriginales ?? [],
        itemsRestantes: input.itemsRestantes ?? [],
        autorizacionRfid: input.autorizacionRfid ?? null,
        detalle: input.detalle ?? null,

        fecha: new Date(),
        timestamp: new Date(),
      },
    ],
    session ? { session } : {},
  );

  if (!doc) {
    throw new Error('No se pudo registrar el audit_log');
  }
};
