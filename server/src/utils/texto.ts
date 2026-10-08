/**
 * Convierte un valor desconocido a texto sin sorpresas.
 *
 * POR QUE EXISTE
 * `String(valor)` con un objeto sin `toString` propio devuelve
 * '[object Object]', que luego se guarda en Mongo y rompe filtros
 * (`Types.ObjectId.isValid('[object Object]')` es false y la anulacion
 * dejaba de devolver stock). Este helper despacha explicito via
 * `toString()` cuando existe y devuelve el valor por defecto en el resto,
 * asi el comportamiento es identico a `String()` en strings, numeros,
 * booleanos y ObjectId, pero nunca cuela '[object Object]'.
 */
export const aTexto = (valor: unknown, porDefecto = ''): string => {
  if (valor === null || valor === undefined) return porDefecto;
  if (typeof valor === 'string') return valor;
  if (typeof valor === 'number' || typeof valor === 'boolean' || typeof valor === 'bigint') {
    return String(valor);
  }
  const toString = (valor as { toString?: unknown }).toString;
  return typeof toString === 'function' ? (valor as { toString(): string }).toString() : porDefecto;
};
