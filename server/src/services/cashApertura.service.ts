import { AuditLog, CashShift } from '../models/index.js';
import { AppError } from '../utils/response.js';
import { claveDoc } from '../utils/cashFlow.js';

export interface AbrirTurnoInput {
  turnoId?: string;
  sucursal: string;
  cajero?: string;
  cajeroId?: string | null;
  fondoInicial?: number;
  sucursalesActivas?: string[];
}

export interface AbrirTurnoResult {
  turnoId: string;
  sucursal: string;
  estadoTurno: string;
  fondoInicial: number;
  cajeroId: string | null;
  cajeroNombre: string;
  fechaApertura: Date;
  /** El POS lo consumia tal cual desde la Cloud Function vieja. */
  fechaAperturaMs: number;
  /** `false` si ya habia un turno abierto y se devolvio ESE. */
  creado: boolean;
}

/** Mismo formato de id que usaba el POS: TURN-<sucursal>-<ms>-<n>. */
const generarTurnoId = (sucursal: string, ahora: Date): string =>
  `TURN-${claveDoc(sucursal).slice(0, 14)}-${ahora.getTime()}-${Math.floor(Math.random() * 1000)}`;

const aResultado = (
  turno: Record<string, unknown>,
  creado: boolean,
): AbrirTurnoResult => {
  const fecha = turno['fechaApertura'] instanceof Date ? (turno['fechaApertura'] as Date) : new Date();
  return {
    turnoId: String(turno['turnoId'] ?? ''),
    sucursal: String(turno['sucursal'] ?? ''),
    estadoTurno: String(turno['estadoTurno'] ?? 'abierto'),
    fondoInicial: Number(turno['fondoInicial'] ?? 0),
    cajeroId: turno['cajeroId'] === undefined || turno['cajeroId'] === null ? null : String(turno['cajeroId']),
    cajeroNombre: String(turno['cajeroNombre'] ?? ''),
    fechaApertura: fecha,
    fechaAperturaMs: fecha.getTime(),
    creado,
  };
};

/**
 * Abre el turno de caja de una sucursal.
 *
 * POR QUE EXISTE
 * El POS llamaba a la Cloud Function `registrarAperturaCaja` (Firebase), que ya
 * no puede funcionar: no hay sesion de Firebase. Sin este endpoint no hay turno
 * nuevo, y sin turno no se puede vender.
 *
 * IDEMPOTENTE A PROPOSITO
 * Si ya hay un turno abierto para la sucursal, devuelve ESE en vez de crear otro.
 *
 * No es un detalle: es el arreglo de la causa raiz de los turnos colgados. El
 * POS buscaba su turno filtrando por `cajeroId`, y como ese campo no estaba
 * declarado en el esquema, `strict: true` lo descartaba al guardar: el filtro
 * nunca coincidia, el POS creia que no habia turno y creaba uno nuevo en cada
 * apertura. Asi quedaron 13 turnos abiertos (San Benito con 9, y varios con el
 * mismo turnoId repetido, porque el indice unico tampoco existia).
 *
 * Con esta comprobacion en el SERVIDOR, el bug no puede volver a pasar aunque
 * el cliente se equivoque: la regla "un turno abierto por sucursal" se aplica
 * donde no se puede saltar.
 */
export const abrirTurno = async (
  input: AbrirTurnoInput,
  context: { ip: string; userAgent: string },
): Promise<AbrirTurnoResult> => {
  const sucursal = String(input.sucursal ?? '').trim();
  if (sucursal === '') {
    throw new AppError('Falta la sucursal', 400, 'MISSING_SUCURSAL');
  }

  const fondoInicial = Number.isFinite(Number(input.fondoInicial))
    ? Math.max(0, Number(input.fondoInicial))
    : 0;

  // 1. Ya hay un turno abierto: se devuelve, no se crea otro.
  const abierto = await CashShift.findOne({ sucursal, estadoTurno: 'abierto' }).lean().exec();
  if (abierto) {
    return aResultado(abierto as unknown as Record<string, unknown>, false);
  }

  const ahora = new Date();
  const turnoId = String(input.turnoId ?? '').trim() || generarTurnoId(sucursal, ahora);
  const cajeroNombre = String(input.cajero ?? '').trim();

  let creado;
  try {
    creado = await CashShift.create({
      turnoId,
      estadoTurno: 'abierto',
      sucursal,
      sucursalesActivas: input.sucursalesActivas ?? [],
      fondoInicial,
      fechaApertura: ahora,
      fechaOperativa: ahora,
      updatedAt: ahora,
      cajeroId: input.cajeroId ?? null,
      cajeroNombre,
      origen: 'pos',
      version: 1,
    });
  } catch (error) {
    // Carrera: otro request abrio el turno entre el findOne y el create. Lo
    // rechaza el indice unico parcial { sucursal, estadoTurno: 'abierto' }; en
    // vez de propagar el error de clave duplicada, se devuelve el que gano.
    if ((error as { code?: number })?.code === 11_000) {
      const otro = await CashShift.findOne({ sucursal, estadoTurno: 'abierto' }).lean().exec();
      if (otro) return aResultado(otro as unknown as Record<string, unknown>, false);
    }
    throw error;
  }

  await AuditLog.create({
    tipo: 'apertura_caja',
    origen: 'api',
    motivo: `Apertura de caja en ${sucursal} con fondo ${fondoInicial}`,
    sucursal,
    turnoId,
    totalDespues: fondoInicial,
    adminNombre: cajeroNombre,
    ip: context.ip,
    userAgent: context.userAgent,
    fecha: ahora,
  });

  return aResultado(creado.toObject() as unknown as Record<string, unknown>, true);
};
