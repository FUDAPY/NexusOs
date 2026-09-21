import { Router } from 'express';
import {
  anularMesasAbiertas,
  cancel,
  create,
  estadoAnulacion,
  list,
  marcarAbonado,
  resolverCobroHandler,
  updateKdsState,
  verificarCodigoAnulacion,
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


/* Autorizacion de anulaciones: tarjeta RFID o codigo cargado a mano.
   Estas rutas van ANTES de '/:id/anular'; si no, Express toma
   'mesas-abiertas' (o 'anulacion') como si fuera el :id de una orden. */
orderRouter.get(
  '/anulacion/estado',
  requiereRol('admin', 'supervisor', 'cajero'),
  asyncHandler(estadoAnulacion),
);

orderRouter.post(
  '/anulacion/verificar-codigo',
  requiereRol('admin', 'supervisor', 'cajero'),
  asyncHandler(verificarCodigoAnulacion),
);

orderRouter.post(
  '/mesas-abiertas/anular',
  requiereRol('admin', 'supervisor', 'cajero'),
  asyncHandler(anularMesasAbiertas),
);

orderRouter.post(
  '/:id/anular',
  requiereRol('admin', 'supervisor', 'cajero'),
  asyncHandler(cancel),
);


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
