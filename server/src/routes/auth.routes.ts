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

/**
 * Login publico. Devuelve JWT + datos del usuario.
 * Si el usuario es migrado y todavia no tiene contraseña, responde 409
 * REQUIERE_PASSWORD.
 *
 * Va con limite de intentos: sin el, una sola IP puede probar contraseñas
 * contra los 62 usuarios migrados sin ningun freno.
 */
authRouter.post(
  '/login',
  limitarIntentos({
    maximo: 10,
    ventanaMs: 5 * 60 * 1000,
    mensaje: 'Demasiados intentos de ingreso.',
  }),
  entrar,
);

/**
 * Alta publica de cliente desde index.html. El rol se fuerza a 'cliente' en el
 * servidor; ver auth.service.ts.
 */
authRouter.post(
  '/registro',
  limitarIntentos({
    maximo: 5,
    ventanaMs: 15 * 60 * 1000,
    mensaje: 'Demasiados registros desde esta conexion.',
  }),
  registrarCliente,
);

/**
 * Autoservicio: cada usuario cambia su propio nombre y contraseña.
 *
 * Los usuarios migrados de Firebase no pueden entrar hasta tener contraseña,
 * asi que para ellos la via es la de administracion de abajo.
 */
authRouter.get('/perfil', requiereAuth, verPerfil);
authRouter.patch('/perfil', requiereAuth, editarPerfil);
authRouter.post(
  '/password',
  requiereAuth,
  // Mas laxo que el login: aca el usuario ya esta autenticado y puede
  // equivocarse escribiendo la contraseña actual.
  limitarIntentos({ maximo: 20, ventanaMs: 5 * 60 * 1000, mensaje: 'Demasiados intentos.' }),
  cambiarClave,
);

/**
 * Administracion: un admin o supervisor cambia el nombre o la contraseña de
 * cualquier usuario existente, incluidos los migrados que todavia no tienen.
 *
 * `/usuarios/:id/password` exige la contraseña ACTUAL del afectado, porque
 * reusa la misma logica que el autoservicio. Sirve cuando el admin la conoce.
 *
 * `/usuarios/:id/reset-password` NO la pide, y es la que usa el panel de
 * Personal: el caso tipico es el cajero que la olvido. Ahi la autorizacion sale
 * del rol, no de conocer la clave anterior.
 */
authRouter.patch('/usuarios/:id/perfil', requiereAuth, requiereRol('admin', 'supervisor'), editarPerfil);
authRouter.post('/usuarios/:id/password', requiereAuth, requiereRol('admin', 'supervisor'), cambiarClave);
authRouter.post(
  '/usuarios/:id/reset-password',
  requiereAuth,
  requiereRol('admin', 'supervisor'),
  // Sin freno, una sesion de admin robada podria cambiar en bucle la
  // contraseña de toda la plantilla y quedarse con las cuentas.
  limitarIntentos({
    maximo: 20,
    ventanaMs: 5 * 60 * 1000,
    mensaje: 'Demasiados cambios de contraseña.',
  }),
  resetearClaveDeUsuario,
);

/**
 * PIN de credito del cliente. Reemplaza a las Cloud Functions de Firebase
 * (`validarPinCreditoCliente` y el alta del PIN), que ya no existen: por eso los
 * PIN no se podian crear desde el panel y la venta a credito quedaba trabada.
 *
 * Definirlo es de admin/supervisor (autoriza fiado), y validarlo tambien lo puede
 * hacer un cajero, que es quien cobra.
 */
authRouter.post('/usuarios/:id/pin', requiereAuth, requiereRol('admin', 'supervisor'), crearPin);
authRouter.post(
  '/credito/validar-pin',
  requiereAuth,
  requiereRol('admin', 'supervisor', 'cajero'),
  // Un PIN de 4 digitos se adivina por fuerza bruta: sin freno, mil intentos por
  // minuto lo rompen. Ademas de los intentos por cliente que cuenta el servicio.
  limitarIntentos({
    maximo: 30,
    ventanaMs: 5 * 60 * 1000,
    mensaje: 'Demasiados intentos de PIN.',
  }),
  validarPin,
);
