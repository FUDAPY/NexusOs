/* - Una venta `pendiente` solo aporta al flujo si es cuenta pendiente o
   metodo 'por cobrar' (buildCashFlowContribution:745). */

/* Zona horaria del negocio. Define que "dia" es para el arqueo. */
export const TZ_NEGOCIO = 'America/Asuncion';


export const texto = (valor: unknown, max = 400): string =>
  String(valor ?? '').trim().slice(0, max);


export const aNumero = (valor: unknown, porDefecto = 0): number => {
  const n = Number(valor);
  return Number.isFinite(n) ? n : porDefecto;
};


export const normalizar = (valor: unknown): string =>
  String(valor ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();


export const claveDoc = (valor: unknown): string =>
  String(valor ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'general';


export const esMetodoCredito = (valor: unknown): boolean => normalizar(valor) === 'credito';


export const resolverFecha = (valor: unknown): Date | null => {
  if (!valor) return null;
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor;
  const conToDate = (valor as { toDate?: () => Date }).toDate;
  if (typeof conToDate === 'function') {
    const convertida = conToDate.call(valor);
    return convertida instanceof Date && !Number.isNaN(convertida.getTime()) ? convertida : null;
  }
  const parseada = new Date(valor as string);
  return Number.isNaN(parseada.getTime()) ? null : parseada;
};


export const fechaKey = (valor: unknown, zona: string = TZ_NEGOCIO): string => {
  if (!(valor instanceof Date) || Number.isNaN(valor.getTime())) return '';
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: zona,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(valor);
  const busca = (tipo: string): string => partes.find((p) => p.type === tipo)?.value ?? '00';
  return `${busca('year')}-${busca('month')}-${busca('day')}`;
};


export type VentaCruda = Record<string, unknown>;

export interface AporteFlujo {
  saleId: string;
  turnoId: string;
  sucursal: string;
  sucursalId: string;
  fechaOperativa: string;
  fechaAperturaMs: number;
  ventaTotalBruta: number;
  efectivo: number;
  tarjetaPOS: number;
  transferencia: number;
  credito: number;
  totalProductos: number;
  totalTickets: number;
  totalTicketsFlujo: number;
  totalTicketsPagados: number;
  totalTicketsPendientes: number;
}

export interface TotalesCierre {
  efectivo: number;
  tarjeta: number;
  transferencia: number;
  credito: number;
}


export const calcularAporte = (saleId: string, venta: VentaCruda): AporteFlujo | null => {
  const turnoId = texto(venta['turnoId'], 180);
  const sucursal = texto(venta['sucursal'], 120);
  if (turnoId === '' || sucursal === '') return null;
  if (venta['arqueado'] === true || venta['marcadoComoAbonado'] === true) return null;
  if (
    venta['tipoTransaccion'] === 'abono_deuda' ||
    venta['tipoTransaccion'] === 'producto_gratis' ||
    venta['noAfectaCaja'] === true
  ) {
    return null;
  }

  const estadoPago = normalizar(venta['estadoPago'] ?? venta['estado']);
  const estadoCocina = normalizar(venta['estadoCocina']);
  const estadoDelivery = normalizar(venta['estadoDelivery']);
  if (
    ['anulado', 'cancelado', 'rechazado'].includes(estadoPago) ||
    estadoCocina === 'anulado' ||
    estadoDelivery === 'anulado'
  ) {
    return null;
  }

  const metodoPago = normalizar(venta['metodoPago'] ?? venta['metodoPagoSolicitado']);
  const esPagado = estadoPago === 'pagado';
  // Una cuenta pendiente SI aporta al flujo (esta por cobrar); una venta
  // pendiente comun no.
  const esPendiente =
    estadoPago === 'pendiente' &&
    (venta['origenCuentaPendiente'] === true || metodoPago === 'por cobrar');
  if (!esPagado && !esPendiente) return null;

  const total = Math.max(0, aNumero(venta['total'], 0));
  let efectivo = 0;
  let tarjetaPOS = 0;
  let transferencia = 0;
  let credito = 0;

  const detalles = venta['detallesPago'] as Record<string, unknown> | null | undefined;

  if (esPagado && metodoPago === 'mixto' && detalles) {
    efectivo = Math.max(0, aNumero(detalles['efectivo'], 0));
    tarjetaPOS = Math.max(0, aNumero(detalles['tarjeta'], 0));
    transferencia = Math.max(0, aNumero(detalles['transferencia'], 0));
  } else if (esPagado && metodoPago === 'efectivo') {
    efectivo = total;
  } else if (esPagado && ['tarjeta', 'pos', 'tarjeta pos'].includes(metodoPago)) {
    tarjetaPOS = total;
  } else if (esPagado && metodoPago === 'transferencia') {
    transferencia = total;
  } else if (esPagado && esMetodoCredito(metodoPago)) {
    credito = total;
  }

  const totalInmediato = efectivo + tarjetaPOS + transferencia;
  const items = Array.isArray(venta['items']) ? (venta['items'] as Record<string, unknown>[]) : [];
  const fechaVenta = resolverFecha(venta['fecha'] ?? venta['createdAt']) ?? new Date();
  const fechaApertura = resolverFecha(venta['fechaAperturaTurno']) ?? fechaVenta;

  return {
    saleId: String(saleId ?? ''),
    turnoId,
    sucursal,
    sucursalId: claveDoc(sucursal),
    fechaOperativa: fechaKey(fechaApertura),
    fechaAperturaMs: fechaApertura.getTime(),
    ventaTotalBruta: totalInmediato + credito,
    efectivo,
    tarjetaPOS,
    transferencia,
    credito,
    totalProductos: items.reduce((suma, item) => suma + Math.max(0, aNumero(item['cantidad'], 0)), 0),
    totalTickets: 1,
    totalTicketsFlujo: totalInmediato > 0 || esPendiente ? 1 : 0,
    totalTicketsPagados: esPagado ? 1 : 0,
    totalTicketsPendientes: esPendiente ? 1 : 0,
  };
};


export const esCandidatoCierreForzado = (venta: VentaCruda, sucursal: string): boolean => {
  if (normalizar(venta['sucursal']) !== normalizar(sucursal)) return false;
  if (venta['arqueado'] === true || venta['marcadoComoAbonado'] === true) return false;
  if (
    venta['tipoTransaccion'] === 'abono_deuda' ||
    venta['tipoTransaccion'] === 'producto_gratis' ||
    venta['noAfectaCaja'] === true
  ) {
    return false;
  }
  const estadoPago = normalizar(venta['estadoPago'] ?? venta['estado']);
  const estadoCocina = normalizar(venta['estadoCocina']);
  const estadoDelivery = normalizar(venta['estadoDelivery']);
  if (
    ['anulado', 'cancelado', 'rechazado'].includes(estadoPago) ||
    estadoCocina === 'anulado' ||
    estadoDelivery === 'anulado'
  ) {
    return false;
  }
  return ['pagado', 'pendiente'].includes(estadoPago);
};

export interface GrupoCierreForzado {
  turnoId: string;
  actualizadoEn: number;
  ventas: { id: string; venta: VentaCruda; fecha: Date }[];
}


export const agruparCierreForzado = (
  ventas: { id: string; venta: VentaCruda }[],
  sucursal: string,
): GrupoCierreForzado | null => {
  const grupos = new Map<string, GrupoCierreForzado>();

  for (const { id, venta } of ventas) {
    if (!esCandidatoCierreForzado(venta, sucursal)) continue;
    const turnoId = texto(venta['turnoId'], 180);
    if (turnoId === '') continue;

    const fecha = resolverFecha(venta['fecha'] ?? venta['createdAt']) ?? new Date(0);
    const grupo = grupos.get(turnoId) ?? { turnoId, actualizadoEn: 0, ventas: [] };
    grupo.actualizadoEn = Math.max(grupo.actualizadoEn, fecha.getTime());
    grupo.ventas.push({ id, venta, fecha });
    grupos.set(turnoId, grupo);
  }

  const ordenados = [...grupos.values()].sort((a, b) => b.actualizadoEn - a.actualizadoEn);
  return ordenados[0] ?? null;
};


export const sumarAportes = (ventas: { id: string; venta: VentaCruda }[]): TotalesCierre => {
  const totales: TotalesCierre = { efectivo: 0, tarjeta: 0, transferencia: 0, credito: 0 };
  for (const { id, venta } of ventas) {
    const aporte = calcularAporte(id, venta);
    if (!aporte) continue;
    totales.efectivo += Math.max(0, aporte.efectivo);
    totales.tarjeta += Math.max(0, aporte.tarjetaPOS);
    totales.transferencia += Math.max(0, aporte.transferencia);
    totales.credito += Math.max(0, aporte.credito);
  }
  return totales;
};


export const agruparProductos = (
  ventas: { venta: VentaCruda }[],
): Record<string, { cant: number; total: number }> => {
  const productos: Record<string, { cant: number; total: number }> = {};
  for (const { venta } of ventas) {
    const items = Array.isArray(venta['items']) ? (venta['items'] as Record<string, unknown>[]) : [];
    for (const item of items) {
      const nombre = texto(item['nombre'], 180) || 'Producto';
      const cantidad = Math.max(0, aNumero(item['cantidad'], 0));
      const precio = Math.max(0, aNumero(item['precioAplicado'] ?? item['precio'], 0));
      const acumulado = productos[nombre] ?? { cant: 0, total: 0 };
      acumulado.cant += cantidad;
      acumulado.total += cantidad * precio;
      productos[nombre] = acumulado;
    }
  }
  return productos;
};
