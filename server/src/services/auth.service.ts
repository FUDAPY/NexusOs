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
  
  requierePassword: boolean;
}

export interface LoginResult {
  token: string;
  expiraEn: string;
  usuario: SesionUsuario;
}


const idDe = (user: IUser & { _id?: unknown }): string => {
  const uid = typeof user.uid === 'string' ? user.uid.trim() : '';
  return uid !== '' ? uid : String(user._id ?? '');
};

/* Datos publicos del usuario: nunca sale passwordHash. */
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

    { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] },
  );


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





export interface RegistroInput {
  nombre: string;
  email: string;
  password: string;
  telefono?: string;
  solicitudPremium?: Record<string, unknown>;
}


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

    throw new AppError('Este correo ya esta registrado', 409, 'EMAIL_EN_USO');
  }

  const creado = await User.create({
    nombre,
    email,
    telefono: input.telefono ?? '',
    passwordHash: await bcrypt.hash(input.password, env.BCRYPT_ROUNDS),
    passwordActualizadoEn: new Date(),

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





const ID_MONGO = /^[a-f0-9]{24}$/i;


const buscarUsuario = (identificador: string) =>
  User.findOne({
    $or: [{ uid: identificador }, ...(ID_MONGO.test(identificador) ? [{ _id: identificador }] : [])],
  }).select('+passwordHash');


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


export const perfil = async (identificador: string): Promise<SesionUsuario> => {
  const user = await buscarUsuario(identificador).lean().exec();
  if (!user) throw new AppError('Usuario no encontrado', 404, 'USUARIO_NO_ENCONTRADO');
  return aSesion(user as unknown as IUser & { _id?: unknown }, (user.passwordHash ?? '') !== '');
};
