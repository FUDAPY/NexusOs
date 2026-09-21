import { Setting } from '../models/index.js';
import { filtroPorId } from '../utils/mongoId.js';
import { AppError } from '../utils/response.js';

/**
 * Autorizacion de anulaciones (tarjeta RFID o codigo cargado a mano).
 *
 * El codigo vive en settings/sistema -> codigoRfidAnulacion y lo valida
 * SOLO el servidor: el POS nunca compara el codigo en el navegador.
 *
 * Se admiten varias tarjetas separadas por coma, punto y coma o espacio
 * (ej. "E2 0A 3C 4B, A1B2C3D4"), asi cada encargado puede tener la suya.
 */

/** Id legacy del documento de configuracion global (settings/sistema). */
export const SETTING_SISTEMA = 'sistema';

/**
 * Normaliza un codigo para compararlo: sin espacios, guiones ni puntos y en
 * minusculas. Un mismo UID puede llegar como "E2 0A 3C 4B", "e2:0a:3c:4b" o
 * "e20a3c4b" segun como lo cargue el encargado o lo mande el lector.
 */
export const normalizarCodigo = (valor: unknown): string => {
  if (valor === null || valor === undefined) return '';
  return String(valor)
    .replace(/[^0-9a-zA-Z]/g, '')
    .toLowerCase();
};

/** Parte la configuracion en codigos: uno por linea, coma o punto y coma. */
export const separarCodigos = (valor: unknown): string[] => {
  const crudos = String(valor ?? '')
    .split(/[\n\r,;]+/)
    .map((codigo) => codigo.trim())
    .filter((codigo) => normalizarCodigo(codigo) !== '');

  const unicos = new Map<string, string>();
  for (const codigo of crudos) {
    const clave = normalizarCodigo(codigo);
    if (!unicos.has(clave)) unicos.set(clave, codigo);
  }
  return [...unicos.values()];
};

/** Compara el codigo ingresado con los configurados (ignora formato y caso). */
export const coincideCodigo = (ingresado: unknown, configurados: readonly string[]): boolean => {
  const objetivo = normalizarCodigo(ingresado);
  if (objetivo === '') return false;

  return configurados.some((codigo) => normalizarCodigo(codigo) === objetivo);
};

/** Codigos de anulacion configurados hoy (nunca se devuelven al cliente). */
export const obtenerCodigosAnulacion = async (): Promise<string[]> => {
  const setting = await Setting.findOne(filtroPorId(SETTING_SISTEMA)).lean().exec();
  return separarCodigos(setting?.codigoRfidAnulacion);
};

export interface AutorizacionAnulacion {
  /** Hay al menos una tarjeta configurada en el panel. */
  requerido: boolean;
  /** El codigo enviado coincide con una tarjeta configurada. */
  verificado: boolean;
}

/**
 * Valida el codigo de anulacion que llega en el body.
 *
 * - `obligatorio: false` (anular un ticket): si no hay ninguna tarjeta
 *   configurada se permite seguir, para no romper las sucursales que todavia
 *   no usan tarjeta; si hay codigo configurado, hay que acertarlo.
 * - `obligatorio: true` (borrar en masa las mesas abiertas): la tarjeta manda,
 *   asi que sin codigo configurado la accion se rechaza.
 */
export const validarCodigoAnulacion = async (
  codigo: unknown,
  opciones: { obligatorio?: boolean } = {},
): Promise<AutorizacionAnulacion> => {
  const obligatorio = opciones.obligatorio === true;
  const codigos = await obtenerCodigosAnulacion();

  if (codigos.length === 0) {
    if (obligatorio) {
      throw new AppError(
        'Configure el codigo RFID de anulacion en el panel de administracion antes de borrar mesas abiertas.',
        428,
        'CODIGO_ANULACION_NO_CONFIGURADO',
      );
    }
    return { requerido: false, verificado: false };
  }

  if (!coincideCodigo(codigo, codigos)) {
    throw new AppError('Codigo de anulacion incorrecto', 403, 'CODIGO_ANULACION_INVALIDO');
  }

  return { requerido: true, verificado: true };
};
