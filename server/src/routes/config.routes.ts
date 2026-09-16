import { Router } from 'express';
import { Setting } from '../models/index.js';
import { filtroPorId } from '../utils/mongoId.js';
import { requiereAuth, requiereRol } from '../middlewares/auth.js';
import { AppError, asyncHandler, sendOk } from '../utils/response.js';

/**
 * Configuracion global (Firestore `config/sistema` -> Mongo `settings`).
 *
 * Existe aparte del CRUD generico porque `/settings` es `soloLectura` ahi: se
 * dejo asi a proposito (config global tocada por un PATCH suelto es peligrosa),
 * pero el dashboard necesita escribir tasas de cambio, limite de credito,
 * descuento de efectivo y el RFID de anulacion. Sin este endpoint esas cuatro
 * pantallas no se pueden migrar.
 *
 * La migracion mapeo `config` -> `settings` (ver migrate-firestore.ts:46).
 */
export const configRouter: Router = Router();

configRouter.use(requiereAuth);

/**
 * Encuentra el documento de configuracion global.
 *
 * Se prueba por el id de Firestore (`config/sistema` -> legacyId 'sistema') y,
 * si no aparece, por la presencia de `divisas`. Ese segundo criterio es el mismo
 * que usa la migracion para derivar currencies, asi que ya esta probado contra
 * los datos reales.
 */
const buscarConfig = async (): Promise<Record<string, unknown> | null> => {
  const porLegacy = await Setting.findOne(filtroPorId('sistema')).lean().exec();
  if (porLegacy) return porLegacy as unknown as Record<string, unknown>;
  const porDivisas = await Setting.findOne({ divisas: { $exists: true } }).lean().exec();
  return porDivisas as unknown as Record<string, unknown> | null;
};

/** El driver de Mongo devuelve el doc; estas son las claves que lo identifican. */
const idDeConfig = (config: Record<string, unknown>): unknown => config['_id'];

configRouter.get(
  '/sistema',
  asyncHandler(async (_req, res) => {
    const config = await buscarConfig();
    if (!config) {
      throw new AppError(
        'No hay documento de configuracion global en settings',
        404,
        'CONFIG_NOT_FOUND',
      );
    }
    sendOk(res, config);
  }),
);

/**
 * Aplana un objeto anidado a notacion de punto para poder mergear sin pisar
 * hermanos: `{ divisas: { USD: 7500 } }` -> `{ 'divisas.USD': 7500 }`.
 *
 * Sin esto, un `$set: { divisas: { USD: 7500 } }` borraria ARS y BRL.
 */
const aplanar = (valor: unknown, prefijo: string, destino: Record<string, unknown>): void => {
  if (valor !== null && typeof valor === 'object' && !Array.isArray(valor) && !(valor instanceof Date)) {
    for (const [clave, hijo] of Object.entries(valor as Record<string, unknown>)) {
      aplanar(hijo, prefijo === '' ? clave : `${prefijo}.${clave}`, destino);
    }
    return;
  }
  if (prefijo !== '') destino[prefijo] = valor;
};

/**
 * PATCH /config/sistema
 * Body: cualquier subconjunto de la config, ej.
 *   { divisas: { USD: 7500 }, limiteCredito: 500000 }
 *
 * Solo admin y supervisor: son valores que mueven plata (tasa de cambio, limite
 * de credito, descuento de efectivo).
 */
configRouter.patch(
  '/sistema',
  requiereRol('admin', 'supervisor'),
  asyncHandler(async (req, res) => {
    const config = await buscarConfig();
    if (!config) {
      throw new AppError('No hay documento de configuracion global', 404, 'CONFIG_NOT_FOUND');
    }

    const cuerpo = (req.body ?? {}) as Record<string, unknown>;
    const cambios: Record<string, unknown> = {};
    aplanar(cuerpo, '', cambios);

    if (Object.keys(cambios).length === 0) {
      throw new AppError('No se recibio ningun cambio', 422, 'SIN_CAMBIOS');
    }

    // Los montos tienen que ser numeros finitos y no negativos: una tasa NaN o
    // negativa rompe todos los cobros en moneda extranjera.
    for (const clave of ['divisas', 'limiteCredito', 'descuentoEfectivo', 'descuentoVip']) {
      for (const [campo, valor] of Object.entries(cambios)) {
        if (!campo.startsWith(clave)) continue;
        if (typeof valor !== 'number' || !Number.isFinite(valor) || valor < 0) {
          throw new AppError(`El campo ${campo} tiene que ser un numero >= 0`, 422, 'VALOR_INVALIDO');
        }
      }
    }

    const actualizado = await Setting.findOneAndUpdate(
      { _id: idDeConfig(config) },
      { $set: { ...cambios, fechaActualizacionCambio: Date.now() } },
      { new: true, runValidators: false },
    )
      .lean()
      .exec();

    if (!actualizado) {
      throw new AppError('No se pudo actualizar la configuracion', 500, 'CONFIG_UPDATE_FAILED');
    }

    sendOk(res, actualizado);
  }),
);
