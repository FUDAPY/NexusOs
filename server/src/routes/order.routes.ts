import { Router } from 'express';
import {
  cancel,
  create,
  list,
  marcarAbonado,
  resolverCobroHandler,
  updateKdsState,
} from '../controllers/order.controller.js';
import { actualizarCuenta, cerrarCuenta } from '../controllers/cuentaCierre.controller.js';
import { asyncHandler } from '../utils/response.js';
import { requiereAuth, requiereRol } from '../middlewares/auth.js';

export const orderRouter: Router = Router();

// Todo /orders exige sesion (ver el control de acceso en app.ts).
orderRouter.use(requiereAuth);

orderRouter.post('/', asyncHandler(create));

orderRouter.get(
  '/resumen',
  requiereRol('admin', 'supervisor', 'cajero'),
  asyncHandler(resumenVentas),
);

orderRouter.get('/', asyncHandler(list));
orderRouter.patch('/:id/cocina', asyncHandler(updateKdsState));


orderRouter.post('/:id/anular', asyncHandler(cancel));


orderRouter.post(
  '/:id/cobro',
  requiereRol('admin', 'supervisor', 'cajero'),
  asyncHandler(resolverCobroHandler),
);


orderRouter.post(
  '/:id/cerrar-cuenta',
  requiereRol('admin', 'supervisor', 'cajero'),
  asyncHandler(cerrarCuenta),
);

import { pagarDeuda, registrarAbono } from '../controllers/pagoDeuda.controller.js';
import { resumenVentas } from '../controllers/reporte.controller.js';


orderRouter.post(
  '/pagar-deuda',
  requiereRol('admin', 'supervisor', 'cajero'),
  asyncHandler(pagarDeuda),
);


orderRouter.post(
  '/abono-pendiente',
  requiereRol('admin', 'supervisor', 'cobrador'),
  asyncHandler(registrarAbono),
);




orderRouter.patch(
  '/:id/cuenta-pendiente',
  requiereRol('admin', 'supervisor', 'cajero'),
  asyncHandler(actualizarCuenta),
);


orderRouter.post(
  '/:id/abonar',
  requiereRol('admin', 'supervisor', 'cajero'),
  asyncHandler(marcarAbonado),
);
