import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export interface KdsOrderEvent {
  orderId: string;
  ticket_id: string;
  sucursal: string;
  estadoCocina: string;
  items: { nombre: string; cantidad: number; obsProd: string }[];
  emitidoEn: string;
}

let io: Server | null = null;


export const registerKdsNamespace = (server: HttpServer): Server => {
  io = new Server(server, {
    cors: { origin: env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : true },
    path: '/realtime',
  });

  const kds = io.of('/kds');

  kds.on('connection', (socket) => {
    const sucursalId = String(socket.handshake.query['sucursalId'] ?? 'unificado');
    void socket.join(sucursalId);
    logger.info({ socketId: socket.id, sucursalId }, 'KDS conectado');

    socket.on('disconnect', () => {
      logger.info({ socketId: socket.id, sucursalId }, 'KDS desconectado');
    });
  });

  return io;
};

export const emitKdsEvent = (sucursal: string, event: 'order:new' | 'order:updated', payload: KdsOrderEvent): void => {
  if (!io) return;
  io.of('/kds').to(sucursal).emit(event, payload);
};





export type EventoTurno =
  | 'venta:creada'
  | 'venta:anulada'
  | 'turno:abierto'
  | 'turno:cerrado'
  | 'stock:cambiado';

export interface PayloadTurno {
  sucursal: string;
  turnoId?: string | null;
  
  id?: string | null;
  
  total?: number;
  ticketId?: string | null;
  estadoPago?: string | null;
  productos?: { productoId: string; cantidad: number }[];
  emitidoEn: string;
}


export const emitTurnoEvent = (sucursal: string, evento: EventoTurno, payload: Partial<PayloadTurno>): void => {
  if (!io) return;
  const cuerpo: PayloadTurno = {
    sucursal,
    turnoId: payload.turnoId ?? null,
    id: payload.id ?? null,
    total: payload.total,
    ticketId: payload.ticketId ?? null,
    estadoPago: payload.estadoPago ?? null,
    productos: payload.productos,
    emitidoEn: new Date().toISOString(),
  };

  const destino = sucursal.trim() === '' ? 'unificado' : sucursal;
  io.of('/kds').to(destino).emit(evento, cuerpo);

  // sucursales; recibe todo para poder mostrar el consolidado.
  if (destino !== 'unificado') io.of('/kds').to('unificado').emit(evento, cuerpo);
};

export const closeSockets = async (): Promise<void> => {
  if (!io) return;
  await io.close();
  io = null;
};
