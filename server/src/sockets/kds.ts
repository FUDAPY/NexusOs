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

/** Namespace /kds: una room por sucursal para no filtrar pedidos entre locales. */
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

export const closeSockets = async (): Promise<void> => {
  if (!io) return;
  await io.close();
  io = null;
};
