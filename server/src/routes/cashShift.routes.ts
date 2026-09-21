import { Router } from 'express';
import { abrir, cerrar, forzarCierre, reconciliar } from '../controllers/cashShift.controller.js';
import { asyncHandler } from '../utils/response.js';
import { requiereAuth, requiereRol } from '../middlewares/auth.js';


export const cashShiftRouter: Router = Router();


cashShiftRouter.post('/abrir', requiereRol('admin', 'supervisor', 'cajero'), asyncHandler(abrir));


cashShiftRouter.post('/cerrar', requiereRol('admin', 'supervisor', 'cajero'), asyncHandler(cerrar));


cashShiftRouter.post(
  '/forzar-cierre',
  requiereAuth,
  requiereRol('admin'),
  asyncHandler(forzarCierre),
);


cashShiftRouter.post('/reconciliar', requiereRol('admin', 'supervisor'), asyncHandler(reconciliar));
