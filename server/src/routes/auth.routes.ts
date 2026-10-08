import { Router } from 'express';
import {
  cambiarClave,
  editarPerfil,
  entrar,
registrarCliente,
  renovarSesion,
  resetearClaveDeUsuario,
  verPerfil,
} from '../controllers/auth.controller.js';
import {
  crearPin,
  validarPin,
} from '../controllers/creditPin.controller.js';
import { requiereAuth, requiereRol } from '../middlewares/auth.js';
import { limitarIntentos } from '../middlewares/rateLimit.js';
import { asyncHandler } from '../utils/response.js';

export const authRouter = Router();


authRouter.post(
  '/login',
  limitarIntentos({
    maximo: 10,
    ventanaMs: 5 * 60 * 1000,
    mensaje: 'Demasiados intentos de ingreso.',
  }),
  asyncHandler(entrar),
);


authRouter.post(
  '/registro',
  limitarIntentos({
    maximo: 5,
    ventanaMs: 15 * 60 * 1000,
    mensaje: 'Demasiados registros desde esta conexion.',
  }),
  asyncHandler(registrarCliente),
);


authRouter.get('/perfil', requiereAuth, asyncHandler(verPerfil));
authRouter.patch('/perfil', requiereAuth, asyncHandler(editarPerfil));

/* Renovacion silenciosa: el cliente la invoca antes de que el token venza.
   Exige un token vigente, asi que no extiende la vida de una sesion robada
   mas alla de la vigencia normal. */
authRouter.post('/refresh', requiereAuth, asyncHandler(renovarSesion));
authRouter.post(
  '/password',
  requiereAuth,

  limitarIntentos({ maximo: 20, ventanaMs: 5 * 60 * 1000, mensaje: 'Demasiados intentos.' }),
  asyncHandler(cambiarClave),
);


authRouter.patch('/usuarios/:id/perfil', requiereAuth, requiereRol('admin', 'supervisor'), asyncHandler(editarPerfil));
authRouter.post('/usuarios/:id/password', requiereAuth, requiereRol('admin', 'supervisor'), asyncHandler(cambiarClave));
authRouter.post(
  '/usuarios/:id/reset-password',
  requiereAuth,
  requiereRol('admin', 'supervisor'),

  limitarIntentos({
    maximo: 20,
    ventanaMs: 5 * 60 * 1000,
    mensaje: 'Demasiados cambios de contraseña.',
  }),
  asyncHandler(resetearClaveDeUsuario),
);


authRouter.post('/usuarios/:id/pin', requiereAuth, requiereRol('admin', 'supervisor'), asyncHandler(crearPin));
authRouter.post(
  '/credito/validar-pin',
  requiereAuth,
  requiereRol('admin', 'supervisor', 'cajero'),
  // Un PIN de 4 digitos se adivina por fuerza bruta: sin freno, mil intentos por

  limitarIntentos({
    maximo: 30,
    ventanaMs: 5 * 60 * 1000,
    mensaje: 'Demasiados intentos de PIN.',
  }),
  asyncHandler(validarPin),
);
