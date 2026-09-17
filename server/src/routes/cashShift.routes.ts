import { Router } from 'express';
import { abrir, cerrar, forzarCierre } from '../controllers/cashShift.controller.js';
import { asyncHandler } from '../utils/response.js';
import { requiereAuth, requiereRol } from '../middlewares/auth.js';

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

/**
 * Apertura del turno de caja.
 *
 * Idempotente: si la sucursal ya tiene un turno abierto devuelve ese, no crea
 * otro. Es la unica forma de abrir un turno (antes lo hacia una Cloud Function
 * de Firebase, que ya no puede funcionar).
 *
 * Mismo conjunto de roles que /cerrar: abre y cierra quien maneja plata.
 */
cashShiftRouter.post('/abrir', requiereRol('admin', 'supervisor', 'cajero'), asyncHandler(abrir));

/**
 * Cierre Z del cajero. Ver cashShift.service.ts para los detalles.
 *
 * Se limita a quien maneja plata: un `cliente` o un rol de `cocina` no deberia
 * poder cerrar una caja. Es el mismo conjunto que ya usan /orders/:id/cobro y
 * /orders/:id/abonar.
 */
cashShiftRouter.post('/cerrar', requiereRol('admin', 'supervisor', 'cajero'), asyncHandler(cerrar));

/**
 * Cierre forzado de una sucursal desde el panel.
 * Solo admin: cierra el turno de OTRA persona y mueve el arqueo completo.
 */
cashShiftRouter.post(
  '/forzar-cierre',
  requiereAuth,
  requiereRol('admin'),
  asyncHandler(forzarCierre),
);
