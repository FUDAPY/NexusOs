/**
 * Conversion de valores con forma de Firestore a tipos de JS/Mongo.
 *
 * POR QUE EXISTE
 * El sistema viejo guarda fechas de TRES formas distintas, y las tres conviven en
 * la misma coleccion `sales`:
 *   - `Timestamp` del SDK (cuando el documento se leyo con el SDK de admin)
 *   - `{ _seconds, _nanoseconds }` (el Timestamp serializado, que es lo que devuelve
 *     la mayoria de los documentos de produccion)
 *   - string ISO suelto (los documentos mas viejos)
 * `resolverFecha()` de cashFlow.ts entiende Date, `toDate()` y string, pero NO el
 * objeto `{_seconds}`: `new Date({...})` da Invalid Date y la venta desaparece del
 * arqueo sin ningun error. Por eso se normaliza ANTES de calcular nada.
 *
 * Es la misma conversion que hace el ETL (`scripts/migrate-firestore.ts`), a
 * proposito: los datos que entran por este puente tienen que quedar igual que los
 * que ya estan migrados.
 */

/** `true` si el valor es un Timestamp serializado por el SDK de Firestore. */
export const esTimestampFirestore = (valor: unknown): valor is { _seconds: number; _nanoseconds: number } => {
  const objeto = valor as { _seconds?: unknown; _nanoseconds?: unknown } | null;
  return (
    typeof valor === 'object' &&
    valor !== null &&
    typeof objeto?._seconds === 'number' &&
    typeof objeto?._nanoseconds === 'number'
  );
};

/** Convierte un Timestamp de Firestore (real o serializado) a Date de JS. */
export const aFecha = (valor: unknown): Date | null => {
  if (valor === null || valor === undefined) return null;
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor;

  const conToDate = (valor as { toDate?: () => Date }).toDate;
  if (typeof conToDate === 'function') {
    const fecha = conToDate.call(valor);
    return fecha instanceof Date && !Number.isNaN(fecha.getTime()) ? fecha : null;
  }

  if (esTimestampFirestore(valor)) {
    return new Date(valor._seconds * 1000 + Math.floor(valor._nanoseconds / 1_000_000));
  }

  if (typeof valor === 'string') {
    const fecha = new Date(valor);
    return Number.isNaN(fecha.getTime()) ? null : fecha;
  }

  if (typeof valor === 'number') {
    const fecha = new Date(valor);
    return Number.isNaN(fecha.getTime()) ? null : fecha;
  }

  return null;
};

/**
 * Convierte un documento entero, campo por campo.
 *
 * Se aplica a TODO el documento (no solo a las fechas conocidas) porque los
 * documentos del sistema viejo traen Timestamps en campos que varian por version:
 * `fechaArqueo`, `fechaMetaPublica`, `fechaAperturaTurno`, y cualquier campo nuevo
 * que agregue el POS viejo. Convertir solo los que hoy conocemos deja el problema
 * esperando al proximo despliegue del POS.
 */
export const aValorMongo = (valor: unknown): unknown => {
  if (valor === null || valor === undefined) return null;
  if (valor instanceof Date) return valor;

  const conToDate = (valor as { toDate?: () => Date }).toDate;
  if (typeof conToDate === 'function') {
    const fecha = conToDate.call(valor);
    if (fecha instanceof Date) return fecha;
  }

  if (esTimestampFirestore(valor)) return aFecha(valor);

  if (Array.isArray(valor)) return valor.map(aValorMongo);

  if (typeof valor === 'object') {
    const salida: Record<string, unknown> = {};
    for (const [clave, entrada] of Object.entries(valor as Record<string, unknown>)) {
      salida[clave] = aValorMongo(entrada);
    }
    return salida;
  }

  return valor;
};
