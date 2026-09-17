import type { NextFunction, Request, Response } from 'express';
import {
  cambiarNombre,
  cambiarPassword,
  login,
  perfil,
  registrar,
  resetearPassword,
} from '../services/auth.service.js';
import type { AuthenticatedRequest } from '../middlewares/auth.js';
import { env } from '../config/env.js';
import { AppError, sendOk } from '../utils/response.js';

/** Datos de contexto que se guardan en la auditoria de cada operacion. */
const contextoDe = (req: Request): { ip: string; userAgent: string } => ({
  ip: req.ip ?? '',
  userAgent: String(req.headers['user-agent'] ?? ''),
});

/** POST /api/v1/auth/login  { email, password } */
export const entrar = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = req.body as { email?: string; password?: string };

    if (typeof body.email !== 'string' || body.email.trim() === '') {
      throw new AppError('Falta el email', 400, 'MISSING_EMAIL');
    }
    if (typeof body.password !== 'string' || body.password === '') {
      throw new AppError('Falta la contraseña', 400, 'MISSING_PASSWORD');
    }

    const resultado = await login(body.email, body.password, contextoDe(req));
    sendOk(res, resultado);
  } catch (error) {
    next(error);
  }
};

/**
 * Identificador del usuario que hace la peticion.
 *
 * Sale de `req.params.id` si viene (cambio desde el panel de admin) o del token
 * si no. El middleware `requiereAuth` deja el usuario en `req.auth`.
 */
const identificadorDe = (req: Request): string => {
  const deParams = req.params['id'];
  if (typeof deParams === 'string' && deParams !== '') return deParams;
  const auth = (req as AuthenticatedRequest).auth;
  if (auth?.userId !== undefined && auth.userId !== '') return auth.userId;
  throw new AppError('No se pudo determinar el usuario', 401, 'SIN_USUARIO');
};

/**
 * POST /api/v1/auth/registro  { nombre, email, password, telefono?, solicitudPremium? }
 *
 * Alta publica de cliente. Devuelve el MISMO sobre que /auth/login
 * ({ token, expiraEn, usuario }) para que el frontend reutilice el guardado de
 * sesion sin un camino aparte.
 */
export const registrarCliente = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = req.body as {
      nombre?: string;
      email?: string;
      password?: string;
      telefono?: string;
      solicitudPremium?: Record<string, unknown>;
    };

    if (typeof body.nombre !== 'string' || typeof body.email !== 'string' || typeof body.password !== 'string') {
      throw new AppError('Se requiere nombre, email y contraseña', 400, 'FALTAN_DATOS');
    }

    const resultado = await registrar(
      {
        nombre: body.nombre,
        email: body.email,
        password: body.password,
        telefono: body.telefono,
        solicitudPremium: body.solicitudPremium,
      },
      contextoDe(req),
    );

    const { token, ...usuario } = resultado;
    sendOk(res, { token, expiraEn: env.JWT_EXPIRES_IN, usuario }, 201);
  } catch (error) {
    next(error);
  }
};

/** GET /api/v1/auth/perfil */
export const verPerfil = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    sendOk(res, await perfil(identificadorDe(req)));
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/v1/auth/perfil  { nombre } */
export const editarPerfil = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = req.body as { nombre?: string };
    if (typeof body.nombre !== 'string') {
      throw new AppError('Falta el nombre', 400, 'MISSING_NAME');
    }
    sendOk(res, await cambiarNombre(identificadorDe(req), body.nombre, contextoDe(req)));
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/auth/password  { actual?, nueva }
 *
 * `actual` es opcional SOLO cuando el usuario todavia no tiene contraseña
 * (los migrados de Firebase). Si ya tiene, es obligatoria.
 */
export const cambiarClave = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = req.body as { actual?: string; nueva?: string };
    if (typeof body.nueva !== 'string' || body.nueva === '') {
      throw new AppError('Falta la contraseña nueva', 400, 'MISSING_NEW_PASSWORD');
    }
    const resultado = await cambiarPassword(identificadorDe(req), body.actual, body.nueva, contextoDe(req));
    sendOk(res, resultado);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/auth/usuarios/:id/reset-password  { nueva }
 *
 * Reseteo desde el panel de admin (Personal). La ruta exige rol admin o
 * supervisor; aca solo se arma la entrada.
 *
 * A diferencia de /auth/password, NO pide la contraseña actual del afectado: el
 * admin no la conoce, y ese es el caso de uso (un cajero que la olvidó).
 */
export const resetearClaveDeUsuario = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const id = req.params['id'];
    if (typeof id !== 'string' || id === '') {
      throw new AppError('Falta el usuario', 400, 'SIN_USUARIO');
    }

    const body = req.body as { nueva?: string };
    if (typeof body.nueva !== 'string' || body.nueva === '') {
      throw new AppError('Falta la contraseña nueva', 400, 'MISSING_NEW_PASSWORD');
    }

    // El nombre y el rol salen del token, NUNCA del body: es lo que hace que la
    // auditoria diga la verdad sobre quien reseteo la cuenta.
    const auth = (req as AuthenticatedRequest).auth;

    sendOk(
      res,
      await resetearPassword(id, body.nueva, contextoDe(req), {
        nombre: auth?.nombre ?? '',
        rol: auth?.rol ?? '',
      }),
    );
  } catch (error) {
    next(error);
  }
};
