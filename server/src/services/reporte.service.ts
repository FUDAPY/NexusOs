import type { PipelineStage } from 'mongoose';
import { Order } from '../models/index.js';
import { AppError } from '../utils/response.js';

/**
 * Resumen financiero agregado de ventas.
 *
 * POR QUE EXISTE
 * Las pantallas de reportes bajaban hasta 1000 ordenes y sumaban en el navegador. Con un
 * historico largo eso es megabytes de JSON y un recorrido completo en JS para dibujar un
 * resumen. Aca la suma la hace Mongo y al navegador le llegan unas pocas decenas de filas.
 *
 * TODO EN UN SOLO $facet
 * Los cuatro desgloses (dia, metodo, sucursal, vendedor) salen de UNA consulta sobre el
 * mismo $match. Hacerlos en cuatro round trips multiplicaria la latencia sin necesidad.
 *
 * QUE NO CUENTA
 * Igual que el arqueo: los anulados se informan aparte y no suman a la venta, y las ordenes
 * con `noAfectaCaja` (abonos de deuda, producto gratis) tampoco. El credito se informa pero
 * es informativo. Es el mismo criterio del POS: si cambia, cambia en un solo lugar.
 */
export interface ResumenInput {
  desde?: string;
  hasta?: string;
  sucursal?: string;
}

export interface ResumenGrupo {
  clave: string;
  tickets: number;
  total: number;
}

export interface ResumenReporte {
  rango: { desde: string | null; hasta: string | null; sucursal: string | null };
  totales: {
    tickets: number;
    ventaTotal: number;
    efectivo: number;
    tarjeta: number;
    transferencia: number;
    credito: number;
    otros: number;
    ticketsAnulados: number;
    totalAnulado: number;
  };
  porDia: ResumenGrupo[];
  porMetodo: ResumenGrupo[];
  porSucursal: ResumenGrupo[];
  porVendedor: ResumenGrupo[];
}

/** Normaliza el metodo de pago para poder agrupar: "POS/Tarjeta", "Tarjeta", etc. */
const metodoNormalizado = {
  $switch: {
    branches: [
      { case: { $regexMatch: { input: { $toLower: { $ifNull: ['$metodoPago', ''] } }, regex: 'efect' } }, then: 'efectivo' },
      { case: { $regexMatch: { input: { $toLower: { $ifNull: ['$metodoPago', ''] } }, regex: 'tarj|pos' } }, then: 'tarjeta' },
      { case: { $regexMatch: { input: { $toLower: { $ifNull: ['$metodoPago', ''] } }, regex: 'transf' } }, then: 'transferencia' },
      { case: { $regexMatch: { input: { $toLower: { $ifNull: ['$metodoPago', ''] } }, regex: 'cred' } }, then: 'credito' },
    ],
    default: 'otros',
  },
} as const;

const groupPor = (expresionClave: unknown) => ({
  clave: expresionClave as Record<string, unknown>,
  tickets: { $sum: 1 },
  total: { $sum: { $toDouble: { $ifNull: ['$total', 0] } } },
});

export const obtenerResumenVentas = async (input: ResumenInput): Promise<ResumenReporte> => {
  const match: Record<string, unknown> = {
    /* Fuera de la venta: lo anulado no vendio y lo que no afecta caja no entro a la caja. */
    anulado: { $ne: true },
    cancelado: { $ne: true },
    noAfectaCaja: { $ne: true },
  };

  const desde = String(input.desde ?? '').trim();
  const hasta = String(input.hasta ?? '').trim();
  const rangoFecha: Record<string, Date> = {};
  if (desde !== '') {
    const fecha = new Date(desde);
    if (Number.isNaN(fecha.getTime())) {
      throw new AppError('`desde` tiene que ser una fecha valida', 422, 'FECHA_INVALIDA');
    }
    rangoFecha.$gte = fecha;
  }
  if (hasta !== '') {
    const fecha = new Date(hasta);
    if (Number.isNaN(fecha.getTime())) {
      throw new AppError('`hasta` tiene que ser una fecha valida', 422, 'FECHA_INVALIDA');
    }
    rangoFecha.$lte = fecha;
  }
  if (Object.keys(rangoFecha).length > 0) match.fecha = rangoFecha;

  const sucursal = String(input.sucursal ?? '').trim();
  if (sucursal !== '') match.sucursal = sucursal;

  const monto = { $toDouble: { $ifNull: ['$total', 0] } };
  const sumarSi = (metodo: string) => ({ $sum: { $cond: [{ $eq: [metodoNormalizado, metodo] }, monto, 0] } });

  const [resultado] = await Order.aggregate([
    { $match: match },
    {
      $facet: {
        totales: [
          {
            $group: {
              _id: null,
              tickets: { $sum: 1 },
              ventaTotal: { $sum: monto },
              efectivo: sumarSi('efectivo'),
              tarjeta: sumarSi('tarjeta'),
              transferencia: sumarSi('transferencia'),
              credito: sumarSi('credito'),
              otros: sumarSi('otros'),
            },
          },
        ],
        /* Los anulados se cuentan aparte, con el mismo rango de fechas y sucursal. */
        anulados: [
          {
            $match: {
              $or: [{ anulado: true }, { cancelado: true }],
              ...(Object.keys(rangoFecha).length > 0 ? { fecha: rangoFecha } : {}),
              ...(sucursal !== '' ? { sucursal } : {}),
            },
          },
          { $group: { _id: null, ticketsAnulados: { $sum: 1 }, totalAnulado: { $sum: monto } } },
        ],
        porDia: [
          {
            $group: groupPor({
              /* $convert con onError: los documentos migrados de Firestore tienen `fecha` como
                 string u objeto, y $dateToString EXIGE un Date. Sin esto, un solo documento
                 sucio hacia fallar la agregacion entera con un 500, que es justo lo que pasaba
                 en produccion. Con $convert, la fecha se interpreta cuando se puede y el resto
                 cae en '' en vez de tumbar todo el resumen. */
              $dateToString: {
                format: '%Y-%m-%d',
                date: { $convert: { input: '$fecha', to: 'date', onError: null, onNull: null } },
                onNull: '',
              },
            }),
          },
          { $sort: { _id: 1 } },
        ],
        porMetodo: [{ $group: groupPor(metodoNormalizado) }, { $sort: { total: -1 } }],
        porSucursal: [{ $group: groupPor({ $ifNull: ['$sucursal', 'Sin sucursal'] }) }, { $sort: { total: -1 } }],
        porVendedor: [{ $group: groupPor({ $ifNull: ['$cajero', 'Sin vendedor'] }) }, { $sort: { total: -1 } }],
      },
    },
  /* El cast es a proposito: la forma de un $facet no se puede validar con tipos (los grupos
     internos son datos, no interfaces), y TypeScript se queda con la primera sobrecarga que
     encuentra. El pipeline esta probado contra Mongo; el tipo solo evita el ruido. */
  ] as unknown as PipelineStage[]).exec();

  const aGrupos = (filas: { _id: unknown; tickets: number; total: number }[] | undefined): ResumenGrupo[] =>
    (filas ?? []).map((fila) => ({
      clave: String(fila._id ?? ''),
      tickets: Number(fila.tickets ?? 0),
      total: Number(fila.total ?? 0),
    }));

  const t = (resultado?.totales?.[0] ?? {}) as Record<string, number>;
  const a = (resultado?.anulados?.[0] ?? {}) as Record<string, number>;

  return {
    rango: {
      desde: desde === '' ? null : desde,
      hasta: hasta === '' ? null : hasta,
      sucursal: sucursal === '' ? null : sucursal,
    },
    totales: {
      tickets: Number(t.tickets ?? 0),
      ventaTotal: Number(t.ventaTotal ?? 0),
      efectivo: Number(t.efectivo ?? 0),
      tarjeta: Number(t.tarjeta ?? 0),
      transferencia: Number(t.transferencia ?? 0),
      credito: Number(t.credito ?? 0),
      otros: Number(t.otros ?? 0),
      ticketsAnulados: Number(a.ticketsAnulados ?? 0),
      totalAnulado: Number(a.totalAnulado ?? 0),
    },
    porDia: aGrupos(resultado?.porDia),
    porMetodo: aGrupos(resultado?.porMetodo),
    porSucursal: aGrupos(resultado?.porSucursal),
    porVendedor: aGrupos(resultado?.porVendedor),
  };
};
