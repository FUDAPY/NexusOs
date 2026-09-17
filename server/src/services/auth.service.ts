import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AuditLog, User } from '../models/index.js';
import type { IUser, UserRol } from '../models/index.js';
import { AppError } from '../utils/response.js';

export interface SesionUsuario {
  id: string;
  nombre: string;
  email: string;
  rol: UserRol;
  sucursal: string;
  /** true si el usuario todavia no tiene contraseña propia (migrado de Firebase). */
  requierePassword: boolean;
}

export interface LoginResult {
  token: string;
  expiraEn: string;
  usuario: SesionUsuario;
}

/**
 * Id publico del usuario.
 *
 * Se prefiere `uid` (el id de Firestore, que el frontend ya conoce) y se cae a
 * `_id` de Mongo. Se compara contra cadena vacia y no con `??` porque los
 * usuarios migrados pueden traer `uid: ''` y una cadena vacia NO es nullish:
 * el `??` la daria por buena y la sesion quedaria sin id.
 */
const idDe = (user: IUser & { _id?: unknown }): string => {
  const uid = typeof user.uid === 'string' ? user.uid.trim() : '';
  return uid !== '' ? uid : String(user._id ?? '');
};

/** Datos publicos del usuario: nunca sale passwordHash. */
const aSesion = (user: IUser & { _id?: unknown }, tienePassword: boolean): SesionUsuario => ({
  id: idDe(user),
  nombre: user.nombre,
  email: user.email,
  rol: user.rol,
  sucursal: user.sucursal,
  requierePassword: !tienePassword,
});

const firmarToken = (usuario: SesionUsuario): string =>
  jwt.sign(
    { sub: usuario.id, rol: usuario.rol, sucursal: usuario.sucursal, nombre: usuario.nombre },
    env.JWT_SECRET,
    // `expiresIn` espera el union StringValue de `ms`, no un string generico;
    // JWT_EXPIRES_IN entra como string desde el entorno, de ahi el cast.
    { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] },
  );

/**
 * Login por email + contraseña.
 *
 * Los usuarios migrados desde Firebase NO tienen contraseña (vivian en Firebase
 * Auth, no en Firestore). En ese caso el login responde 409 con
 * code REQUIERE_PASSWORD para que el frontend los mande a establecerla, en vez
 * de dar un "credenciales invalidas" que confundiria al cajero.
 */
export const login = async (
  email: string,
  password: string,
  context: { ip: string; userAgent: string },
): Promise<LoginResult> => {
  const user = await User.findOne({ email: email.trim().toLowerCase() })
    .select('+passwordHash')
    .lean()
    .exec();

  if (!user) {
    // Mismo mensaje si el usuario no existe o si la clave esta mal: no se filtra
    // que emails estan registrados.
    throw new AppError('Credenciales invalidas', 401, 'CREDENCIALES_INVALIDAS');
  }

  const hash = user.passwordHash ?? '';

  if (hash === '') {
    throw new AppError(
      'Este usuario todavia no tiene contraseña. Establecela para poder entrar.',
      409,
      'REQUIERE_PASSWORD',
    );
  }

  const coincide = await bcrypt.compare(password, hash);
  if (!coincide) {
    throw new AppError('Credenciales invalidas', 401, 'CREDENCIALES_INVALIDAS');
  }

  const usuario = aSesion(user as IUser & { _id?: unknown }, hash !== '');

  await AuditLog.create({
    tipo: 'login',
    origen: 'api',
    motivo: `Ingreso de ${usuario.nombre}`,
    sucursal: usuario.sucursal,
    adminNombre: usuario.nombre,
    ip: context.ip,
    userAgent: context.userAgent,
    fecha: new Date(),
  });

  return {
    token: firmarToken(usuario),
    expiraEn: env.JWT_EXPIRES_IN,
    usuario,
  };
};

/* ------------------------------------------------------------------ */
/* Alta publica de cliente                                             */
/* ------------------------------------------------------------------ */

export interface RegistroInput {
  nombre: string;
  email: string;
  password: string;
  telefono?: string;
  solicitudPremium?: Record<string, unknown>;
}

/**
 * Alta publica de cliente, para la pantalla de registro de index.html.
 *
 * El `rol` se fuerza a 'cliente' en el SERVIDOR y nunca se lee del body: si se
 * aceptara el que manda el cliente, cualquiera podria registrarse como admin.
 * Por eso no se reusa POST /users, que es el CRUD generico.
 *
 * Los campos de solicitudPremium se copian tal cual porque el formulario del
 * cliente los arma para el programa de beneficios.
 */
export const registrar = async (
  input: RegistroInput,
  context: { ip: string; userAgent: string },
): Promise<SesionUsuario & { token: string }> => {
  const nombre = input.nombre.trim();
  const email = input.email.trim().toLowerCase();

  if (nombre.length < 3) {
    throw new AppError('El nombre tiene que tener al menos 3 caracteres', 422, 'NOMBRE_CORTO');
  }
  if (!email.includes('@')) {
    throw new AppError('El email no es valido', 422, 'EMAIL_INVALIDO');
  }
  if (input.password.length < 6) {
    throw new AppError('La contraseña tiene que tener al menos 6 caracteres', 422, 'PASSWORD_CORTA');
  }

  const existente = await User.findOne({ email }).lean().exec();
  if (existente) {
    // 409 y no 422: el correo ya esta tomado, no es un dato mal escrito.
    throw new AppError('Este correo ya esta registrado', 409, 'EMAIL_EN_USO');
  }

  const creado = await User.create({
    nombre,
    email,
    telefono: input.telefono ?? '',
    passwordHash: await bcrypt.hash(input.password, env.BCRYPT_ROUNDS),
    passwordActualizadoEn: new Date(),
    // Forzado, no negociable desde el cliente.
    rol: 'cliente',
    tipoCliente: 'estandar',
    estadoBeneficios: 'pendiente',
    puntos: 0,
    deuda: 0,
    datosCompletos: false,
    playTesterStatus: 'pending',
    ...(input.solicitudPremium === undefined ? {} : { solicitudPremium: input.solicitudPremium }),
  });

  await AuditLog.create({
    tipo: 'usuario_creado',
    origen: 'registro_publico',
    motivo: `Alta de cliente ${nombre} <${email}>`,
    adminNombre: nombre,
    ip: context.ip,
    userAgent: context.userAgent,
    fecha: new Date(),
  });

  const usuario = aSesion(creado.toObject() as IUser & { _id?: unknown }, true);
  return { ...usuario, token: firmarToken(usuario) };
};

/* ------------------------------------------------------------------ */
/* Perfil: cambiar nombre y contraseña                                  */
/* ------------------------------------------------------------------ */

const ID_MONGO = /^[a-f0-9]{24}$/i;

/**
 * Query base del usuario: busca por `uid` (id de Firestore) o por `_id` de Mongo,
 * y trae el hash de la contraseña, que el schema oculta con `select: false`.
 *
 * Devuelve la Query, no una promesa: asi los llamadores pueden encadenar
 * `.lean().exec()` y el tipo del resultado se conserva.
 */
const buscarUsuario = (identificador: string) =>
  User.findOne({
    $or: [{ uid: identificador }, ...(ID_MONGO.test(identificador) ? [{ _id: identificador }] : [])],
  }).select('+passwordHash');

/**
 * Cambia el nombre visible del usuario.
 * Devuelve la sesion actualizada para que el frontend refresque el menu.
 */
export const cambiarNombre = async (
  identificador: string,
  nombre: string,
  context: { ip: string; userAgent: string },
): Promise<SesionUsuario> => {
  const limpio = nombre.trim();
  if (limpio.length < 3) {
    throw new AppError('El nombre tiene que tener al menos 3 caracteres', 422, 'NOMBRE_CORTO');
  }

  const user = await buscarUsuario(identificador);
  if (!user) throw new AppError('Usuario no encontrado', 404, 'USUARIO_NO_ENCONTRADO');

  const anterior = user.nombre;
  user.nombre = limpio;
  await user.save();

  await AuditLog.create({
    tipo: 'usuario_editado',
    origen: 'api',
    motivo: `Nombre cambiado de "${anterior}" a "${limpio}"`,
    sucursal: user.sucursal,
    adminNombre: limpio,
    ip: context.ip,
    userAgent: context.userAgent,
    fecha: new Date(),
  });

  return aSesion(user.toObject() as IUser & { _id?: unknown }, (user.passwordHash ?? '') !== '');
};

/**
 * Cambia (o establece por primera vez) la contraseña.
 *
 * Si el usuario YA tiene contraseña, se exige la actual. Si NO la tiene —caso de
 * los 62 usuarios migrados de Firebase, cuyas contraseñas vivian en Firebase Auth
 * y no se pudieron migrar— se permite establecerla sin la anterior. Es la unica
 * forma de que esos usuarios puedan entrar al sistema nuevo.
 */
export const cambiarPassword = async (
  identificador: string,
  actual: string | undefined,
  nueva: string,
  context: { ip: string; userAgent: string },
): Promise<{ establecida: boolean; primeraVez: boolean }> => {
  if (nueva.length < 6) {
    throw new AppError('La contraseña tiene que tener al menos 6 caracteres', 422, 'PASSWORD_CORTA');
  }

  const user = await buscarUsuario(identificador);
  if (!user) throw new AppError('Usuario no encontrado', 404, 'USUARIO_NO_ENCONTRADO');

  const hashActual = user.passwordHash ?? '';
  const primeraVez = hashActual === '';

  if (!primeraVez) {
    if (typeof actual !== 'string' || actual === '') {
      throw new AppError('Falta la contraseña actual', 422, 'FALTA_PASSWORD_ACTUAL');
    }
    const coincide = await bcrypt.compare(actual, hashActual);
    if (!coincide) {
      throw new AppError('La contraseña actual no coincide', 401, 'PASSWORD_ACTUAL_INCORRECTA');
    }
  }

  user.passwordHash = await bcrypt.hash(nueva, env.BCRYPT_ROUNDS);
  user.passwordActualizadoEn = new Date();
  await user.save();

  await AuditLog.create({
    tipo: 'usuario_editado',
    origen: 'api',
    motivo: primeraVez ? 'Contraseña establecida por primera vez' : 'Contraseña cambiada',
    sucursal: user.sucursal,
    adminNombre: user.nombre,
    ip: context.ip,
    userAgent: context.userAgent,
    fecha: new Date(),
  });

  return { establecida: true, primeraVez };
};

/**
 * Restablece la contraseña de OTRO usuario desde el panel de admin.
 *
 * Por que NO reusa `cambiarPassword`: esa exige la contraseña actual cuando el
 * usuario ya tiene una, y el admin no la conoce — ese es justamente el caso de
 * uso (un cajero que la olvidó). Meter un flag para saltear ese control dejaria
 * una puerta trasera en el camino de autoservicio; una funcion aparte deja
 * explicito que aca la autorizacion NO viene de conocer la clave anterior, sino
 * del rol, y eso lo exige la ruta con `requiereRol('admin','supervisor')`.
 *
 * La auditoria queda a nombre de `quienLoHace` (el admin del token), no del
 * afectado: si se registrara como "Contraseña cambiada" a nombre del cajero, se
 * perderia el rastro de quien reseteo que cuenta.
 */
export const resetearPassword = async (
  identificador: string,
  nueva: string,
  context: { ip: string; userAgent: string },
  quienLoHace: { nombre: string; rol: string },
): Promise<{ establecida: boolean; primeraVez: boolean; usuario: string }> => {
  if (nueva.length < 6) {
    throw new AppError('La contraseña tiene que tener al menos 6 caracteres', 422, 'PASSWORD_CORTA');
  }

  const user = await buscarUsuario(identificador);
  if (!user) throw new AppError('Usuario no encontrado', 404, 'USUARIO_NO_ENCONTRADO');

  const primeraVez = (user.passwordHash ?? '') === '';

  user.passwordHash = await bcrypt.hash(nueva, env.BCRYPT_ROUNDS);
  user.passwordActualizadoEn = new Date();
  await user.save();

  await AuditLog.create({
    tipo: 'usuario_editado',
    origen: 'api',
    motivo:
      `${primeraVez ? 'Contraseña establecida' : 'Contraseña restablecida'} por ` +
      `${quienLoHace.nombre} (${quienLoHace.rol}) para ${user.nombre}`,
    sucursal: user.sucursal,
    adminNombre: quienLoHace.nombre,
    ip: context.ip,
    userAgent: context.userAgent,
    fecha: new Date(),
  });

  return { establecida: true, primeraVez, usuario: user.nombre };
};

/** Perfil actual, para que el frontend sepa si tiene que pedir la contraseña. */
export const perfil = async (identificador: string): Promise<SesionUsuario> => {
  const user = await buscarUsuario(identificador).lean().exec();
  if (!user) throw new AppError('Usuario no encontrado', 404, 'USUARIO_NO_ENCONTRADO');
  return aSesion(user as unknown as IUser & { _id?: unknown }, (user.passwordHash ?? '') !== '');
};
