import { ProductionBatch, ProductionConfig } from '../models/index.js';
import { AppError } from '../utils/response.js';
import { withTransaction } from '../utils/withTransaction.js';
import { recordAudit } from './audit.service.js';

/**
 * Que contadores mueve cada tipo de insumo, con los nombres EXACTOS del modelo.
 * Si un tipo llegara sin estar aca se rechaza, en vez de guardar un lote que no
 * incrementa nada: seria mercaderia ingresada que el sistema no ve.
 */
const INSUMOS: Record<string, { disponibles: string; ingresados: string; generados: string }> = {
  medallones: { disponibles: 'medallonesDisponibles', ingresados: 'medallonesIngresados', generados: 'medallonesGenerados' },
  panes: { disponibles: 'panesDisponibles', ingresados: 'panesIngresados', generados: 'panesGenerados' },
  papas: { disponibles: 'papasDisponibles', ingresados: 'papasIngresadas', generados: 'papasGeneradas' },
  carne_salteado: { disponibles: 'carneSalteadoDisponible', ingresados: 'carneSalteadoIngresada', generados: 'carneSalteadoGenerada' },
  carne_lomito: { disponibles: 'carneLomitoDisponible', ingresados: 'carneLomitoIngresada', generados: 'carneLomitoGenerada' },
  pan_lomito: { disponibles: 'panLomitoDisponible', ingresados: 'panLomitoIngresado', generados: 'panLomitoGenerado' },
};

export interface RegistrarLoteInput {
  sucursalKey: string;
  sucursal?: string;
  tipoInsumo: string;
  cantidad: number;
  unidad?: string;
  observacion?: string;
  creadoPor?: string;
  creadoPorNombre?: string;
}

export interface RegistrarLoteResult {
  loteId: string;
  sucursalKey: string;
  tipoInsumo: string;
  cantidad: number;
  /** Contadores de la sucursal despues de acreditar el lote. */
  disponibles: number;
  ingresados: number;
}

/**
 * Registra un lote de produccion: crea el lote Y acredita la cantidad en los
 * contadores de la sucursal, en una transaccion.
 *
 * POR QUE ES UN ENDPOINT Y NO UN PATCH DEL PANEL
 * Hacerlo desde el navegador seria leer el contador, sumarle la cantidad y escribir:
 * dos personas cargando produccion al mismo tiempo se pisan y un lote se pierde sin
 * que nadie lo note, porque el lote SI queda guardado y el contador no lo refleja. La
 * transaccion hace las dos cosas o ninguna.
 */
export const registrarLote = async (
  input: RegistrarLoteInput,
  context: { ip: string; userAgent: string },
): Promise<RegistrarLoteResult> => {
  const sucursalKey = String(input.sucursalKey ?? '').trim();
  if (sucursalKey === '') throw new AppError('Falta la sucursal', 400, 'MISSING_SUCURSAL_KEY');

  const tipoInsumo = String(input.tipoInsumo ?? '').trim();
  const mapa = INSUMOS[tipoInsumo];
  if (!mapa) {
    throw new AppError(`Tipo de insumo desconocido: ${tipoInsumo}`, 422, 'TIPO_INSUMO_INVALIDO');
  }

  const cantidad = Math.round(Number(input.cantidad ?? 0));
  if (!Number.isFinite(cantidad) || cantidad <= 0) {
    throw new AppError('La cantidad tiene que ser mayor a cero', 422, 'CANTIDAD_INVALIDA');
  }

  const sucursal = String(input.sucursal ?? '');
  const unidad = String(input.unidad ?? 'unidades');

  const resultado = await withTransaction(async (session) => {
    const opciones = session ? { session } : {};

    /* `upsert` con $inc sobre los dos contadores: si la sucursal todavia no tiene
       configuracion de produccion, se crea con el lote ya acreditado en vez de fallar.
       Sin el upsert, cargar el primer lote de una sucursal nueva no se podria. */
    const config = await ProductionConfig.findOneAndUpdate(
      { legacyId: sucursalKey },
      {
        $inc: { [mapa.disponibles]: cantidad, [mapa.ingresados]: cantidad },
        $set: { sucursal, sucursalKey, updatedAt: new Date(), updatedBy: input.creadoPor ?? '', updatedByNombre: input.creadoPorNombre ?? '' },
        $setOnInsert: { legacyId: sucursalKey },
      },
      { new: true, upsert: true, ...opciones },
    ).exec();

    const [lote] = await ProductionBatch.create(
      [
        {
          tipoInsumo,
          unidad,
          sucursal,
          sucursalKey,
          cantidadIngresada: cantidad,
          cantidadAcreditada: cantidad,
          [mapa.generados]: cantidad,
          observacion: String(input.observacion ?? ''),
          createdBy: input.creadoPor ?? '',
          createdByNombre: input.creadoPorNombre ?? '',
          createdAt: new Date(),
        },
      ],
      opciones,
    );

    if (!lote) throw new AppError('No se pudo registrar el lote', 500, 'LOTE_CREATE_FAILED');

    await recordAudit(
      {
        tipo: 'produccion_lote',
        origen: 'panel',
        motivo: `Lote de ${tipoInsumo} por ${cantidad} ${unidad} en ${sucursal}`,
        sucursal,
        adminNombre: input.creadoPorNombre ?? '',
        ventaId: String(lote._id),
        detalle: { ip: context.ip, userAgent: context.userAgent, tipoInsumo, cantidad },
      },
      session,
    );

    const plano = (config ?? {}) as unknown as Record<string, number>;

    return {
      loteId: String(lote._id),
      sucursalKey,
      tipoInsumo,
      cantidad,
      disponibles: Number(plano[mapa.disponibles] ?? 0),
      ingresados: Number(plano[mapa.ingresados] ?? 0),
    };
  });

  return resultado;
};
