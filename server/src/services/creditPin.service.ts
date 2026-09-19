import bcrypt from 'bcryptjs';
import { CreditPin, User } from '../models/index.js';
import { AppError } from '../utils/response.js';
import { recordAudit } from './audit.service.js';

/** Intentos fallidos antes de bloquear el PIN. */
const MAX_INTENTOS = 3;
/** Cuanto dura el bloqueo. */
const MINUTOS_BLOQUEO = 5;

/** Un hash bcrypt se reconoce por el prefijo. */
const esHash = (valor: string): boolean => /^\$2[aby]\$/.test(valor);

/**
 * Deja rastro en la auditoria: quien definio o intento un PIN, y desde donde.
 * Un PIN autoriza fiado, asi que cada intento tiene que quedar registrado: sin esto
 * no hay forma de saber si alguien estuvo probando combinaciones.
 */
const registrarIntento = async (
  clienteId: string,
  subtipo: string,
  context: { ip: string; userAgent: string },
): Promise<void> => {
  await recordAudit({
    tipo: 'pin_credito',
    subtipo,
    motivo: `PIN de credito (${subtipo}) del cliente ${clienteId}`,
    clienteId,
    detalle: { ip: context.ip, userAgent: context.userAgent },
  });
};

export interface ResultadoValidacionPin {
  valido: boolean;
  motivo?: 'SIN_PIN' | 'PIN_INCORRECTO' | 'BLOQUEADO' | 'CLIENTE_INEXISTENTE';
  intentosRestantes?: number;
  bloqueadoHasta?: Date | null;
}

/**
 * Define (o quita) el PIN de credito de un cliente.
 *
 * Se guarda HASHEADO con bcrypt, igual que las contrasenas: el PIN autoriza fiado,
 * o sea que mueve plata, y guardarlo en claro significa que cualquiera con acceso a
 * la base lo conoce. El modelo `credit_pins` NO lo declara oculto, asi que el hash
 * es la unica proteccion real.
 *
 * `pin` vacio = quitar el PIN (y apagar `creditoPinConfigurado` en el usuario, que es
 * el flag que mira el POS para pedirlo).
 */
export const establecerPinCredito = async (
  clienteId: string,
  pin: string,
  context: { ip: string; userAgent: string },
): Promise<{ clienteId: string; configurado: boolean }> => {
  const id = String(clienteId ?? '').trim();
  if (id === '') throw new AppError('Falta el cliente', 400, 'MISSING_CLIENTE');

  const limpio = String(pin ?? '').trim();
  const quitar = limpio === '';

  // 4 digitos como minimo: es lo que valida el POS al pedirlo.
  if (!quitar && !/^\d{4,8}$/.test(limpio)) {
    throw new AppError('El PIN tiene que ser de 4 a 8 numeros', 422, 'PIN_INVALIDO');
  }

  const cliente = await User.findById(id).exec();
  if (!cliente) throw new AppError('No existe ese cliente', 404, 'CLIENTE_INEXISTENTE');

  const ahora = new Date();
  const hash = quitar ? '' : await bcrypt.hash(limpio, 10);

  await CreditPin.findOneAndUpdate(
    { clienteId: id },
    {
      $set: {
        pin: hash,
        activo: !quitar,
        intentosFallidos: 0,
        bloqueadoHasta: null,
        actualizadoEn: ahora,
      },
      $setOnInsert: { creadoEn: ahora },
    },
    { upsert: true, new: true },
  ).exec();

  /* Los dos flags del usuario son los que el POS consulta para decidir si pide el
     PIN. Si no se mantienen sincronizados, el POS pide un PIN que ya no existe (o
     deja pasar sin pedirlo), y cualquiera de las dos es peor que un error. */
  cliente.creditoPinConfigurado = !quitar;
  if (quitar) cliente.solicitarPinCredito = false;
  await cliente.save();

  await registrarIntento(id, quitar ? 'pin_quitado' : 'pin_definido', context);

  return { clienteId: id, configurado: !quitar };
};

/**
 * Valida el PIN de un cliente para autorizar un fiado.
 *
 * Compatibilidad: los PIN migrados pueden estar en claro (el modelo no dice como
 * estan). Si el guardado no parece un hash de bcrypt se compara directo, y en el
 * proximo cambio de PIN queda hasheado. Asi ninguna autorizacion vieja se rompe.
 */
export const validarPinCredito = async (
  clienteId: string,
  pin: string,
  context: { ip: string; userAgent: string },
): Promise<ResultadoValidacionPin> => {
  const id = String(clienteId ?? '').trim();
  const limpio = String(pin ?? '').trim();
  if (id === '') throw new AppError('Falta el cliente', 400, 'MISSING_CLIENTE');

  const registro = await CreditPin.findOne({ clienteId: id }).exec();
  if (!registro || !registro.pin) {
    return { valido: false, motivo: 'SIN_PIN' };
  }

  const ahora = new Date();
  if (registro.bloqueadoHasta && registro.bloqueadoHasta > ahora) {
    return { valido: false, motivo: 'BLOQUEADO', bloqueadoHasta: registro.bloqueadoHasta };
  }

  const guardado = String(registro.pin);
  const coincide = esHash(guardado) ? await bcrypt.compare(limpio, guardado) : guardado === limpio;

  if (coincide) {
    registro.intentosFallidos = 0;
    registro.bloqueadoHasta = null;
    registro.actualizadoEn = ahora;
    await registro.save();
    await registrarIntento(id, 'pin_ok', context);
    return { valido: true };
  }

  // Falla: se cuentan los intentos y se bloquea al llegar al maximo. El limite
  // existe porque un PIN de 4 digitos se adivina por fuerza bruta en minutos.
  const intentos = Number(registro.intentosFallidos ?? 0) + 1;
  const bloqueado = intentos >= MAX_INTENTOS;
  registro.intentosFallidos = bloqueado ? 0 : intentos;
  registro.bloqueadoHasta = bloqueado ? new Date(ahora.getTime() + MINUTOS_BLOQUEO * 60_000) : null;
  registro.actualizadoEn = ahora;
  await registro.save();
  await registrarIntento(id, 'pin_rechazado', context);

  return {
    valido: false,
    motivo: bloqueado ? 'BLOQUEADO' : 'PIN_INCORRECTO',
    intentosRestantes: bloqueado ? 0 : MAX_INTENTOS - intentos,
    bloqueadoHasta: registro.bloqueadoHasta,
  };
};
