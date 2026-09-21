import { Router } from 'express';
import {
  cambiarClave,
  editarPerfil,
  entrar,
  registrarCliente,
  resetearClaveDeUsuario,
  verPerfil,
} from '../controllers/auth.controller.js';
import {
  crearPin,
  validarPin,
} from '../controllers/creditPin.controller.js';
import { requiereAuth, requiereRol } from '../middlewares/auth.js';
import { limitarIntentos } from '../middlewares/rateLimit.js';

export const authRouter = Router();


authRouter.post(
  '/login',
  limitarIntentos({
    maximo: 10,
    ventanaMs: 5 * 60 * 1000,
    mensaje: 'Demasiados intentos de ingreso.',
  }),
  entrar,
);


authRouter.post(
  '/registro',
  limitarIntentos({
    maximo: 5,
    ventanaMs: 15 * 60 * 1000,
    mensaje: 'Demasiados registros desde esta conexion.',
  }),
  registrarCliente,
);


authRouter.get('/perfil', requiereAuth, verPerfil);
authRouter.patch('/perfil', requiereAuth, editarPerfil);
authRouter.post(
  '/password',
  requiereAuth,

  limitarIntentos({ maximo: 20, ventanaMs: 5 * 60 * 1000, mensaje: 'Demasiados intentos.' }),
  cambiarClave,
);


authRouter.patch('/usuarios/:id/perfil', requiereAuth, requiereRol('admin', 'supervisor'), editarPerfil);
authRouter.post('/usuarios/:id/password', requiereAuth, requiereRol('admin', 'supervisor'), cambiarClave);
authRouter.post(
  '/usuarios/:id/reset-password',
  requiereAuth,
  requiereRol('admin', 'supervisor'),

  limitarIntentos({
    maximo: 20,
    ventanaMs: 5 * 60 * 1000,
    mensaje: 'Demasiados cambios de contraseña.',
  }),
  resetearClaveDeUsuario,
);


authRouter.post('/usuarios/:id/pin', requiereAuth, requiereRol('admin', 'supervisor'), crearPin);
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
  validarPin,
);
