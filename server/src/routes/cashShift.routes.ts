import { Router } from 'express';
import { cerrar } from '../controllers/cashShift.controller.js';
import { asyncHandler } from '../utils/response.js';

/**
 * Operaciones de escritura sobre turnos de caja.
 *
 * Se monta ANTES que resourceRouter en app.ts, sobre el mismo prefijo:
 *   POST /cash-shifts/cerrar  -> aca (logica transaccional propia)
 *   GET  /cash-shifts         -> resourceRouter (CRUD generico)
 *
 * Express prueba los routers en orden, asi que /cerrar se resuelve aca y el
 * resto cae al CRUD sin conflicto.
 */
export const cashShiftRouter: Router = Router();

/** Cierre Z del cajero. Ver cashShift.service.ts para los detalles. */
cashShiftRouter.post('/cerrar', asyncHandler(cerrar));
