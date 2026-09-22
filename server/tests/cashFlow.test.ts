import { describe, expect, it } from 'vitest';
import {
  agruparCierreForzado,
  agruparProductos,
  calcularAporte,
  esCandidatoCierreForzado,
  fechaHoraTexto,
  normalizar,
  sumarAportes,
} from '../src/utils/cashFlow.js';


const ventaBase = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  turnoId: 'TURN-1',
  sucursal: 'Centro',
  estadoPago: 'pagado',
  metodoPago: 'Efectivo',
  total: 100_000,
  arqueado: false,
  ...extra,
});

describe('calcularAporte: metodo de pago', () => {
  it('efectivo suma al efectivo', () => {
    expect(calcularAporte('o1', ventaBase())?.efectivo).toBe(100_000);
  });

  it('tarjeta suma al POS', () => {
    expect(calcularAporte('o1', ventaBase({ metodoPago: 'Tarjeta' }))?.tarjetaPOS).toBe(100_000);
  });

  it('transferencia suma a transferencia', () => {
    expect(calcularAporte('o1', ventaBase({ metodoPago: 'Transferencia' }))?.transferencia).toBe(100_000);
  });

  it('credito suma al credito, no al efectivo', () => {
    const aporte = calcularAporte('o1', ventaBase({ metodoPago: 'Credito' }));
    expect(aporte?.credito).toBe(100_000);
    expect(aporte?.efectivo).toBe(0);
  });

  it('reconoce "Crédito" con acento y mayusculas', () => {
    // El original compara contra 'credito' ya normalizado (functions:362).
    expect(calcularAporte('o1', ventaBase({ metodoPago: 'CRÉDITO' }))?.credito).toBe(100_000);
    expect(normalizar('CRÉDITO')).toBe('credito');
  });

  it('mixto reparte segun detallesPago', () => {
    const aporte = calcularAporte(
      'o1',
      ventaBase({
        metodoPago: 'Mixto',
        detallesPago: { efectivo: 40_000, tarjeta: 60_000, transferencia: 0 },
      }),
    );
    expect(aporte?.efectivo).toBe(40_000);
    expect(aporte?.tarjetaPOS).toBe(60_000);
  });

  it('un total negativo no se propaga', () => {
    expect(calcularAporte('o1', ventaBase({ total: -5_000 }))?.efectivo).toBe(0);
  });
});

describe('calcularAporte: que NO aporta', () => {
  it('una venta ya arqueada', () => {
    expect(calcularAporte('o1', ventaBase({ arqueado: true }))).toBeNull();
  });

  it('un ticket marcado como abonado', () => {
    expect(calcularAporte('o1', ventaBase({ marcadoComoAbonado: true }))).toBeNull();
  });

  it('una venta anulada', () => {
    expect(calcularAporte('o1', ventaBase({ estadoPago: 'anulado' }))).toBeNull();
  });

  it('un rechazo de cobro', () => {
    expect(calcularAporte('o1', ventaBase({ estadoPago: 'rechazado' }))).toBeNull();
  });

  it('cocina anulada, aunque este pagada', () => {
    expect(calcularAporte('o1', ventaBase({ estadoCocina: 'anulado' }))).toBeNull();
  });

  it('un abono de deuda (no es venta)', () => {
    expect(calcularAporte('o1', ventaBase({ tipoTransaccion: 'abono_deuda' }))).toBeNull();
  });

  it('un producto gratis', () => {
    expect(calcularAporte('o1', ventaBase({ tipoTransaccion: 'producto_gratis' }))).toBeNull();
  });

  it('una venta marcada noAfectaCaja', () => {
    expect(calcularAporte('o1', ventaBase({ noAfectaCaja: true }))).toBeNull();
  });

  it('una venta pendiente comun', () => {
    expect(calcularAporte('o1', ventaBase({ estadoPago: 'pendiente' }))).toBeNull();
  });

  it('sin turnoId o sin sucursal', () => {
    expect(calcularAporte('o1', ventaBase({ turnoId: '' }))).toBeNull();
    expect(calcularAporte('o1', ventaBase({ sucursal: '' }))).toBeNull();
  });
});

describe('cuentas pendientes', () => {
  it('una cuenta pendiente SI aporta al flujo', () => {
    const aporte = calcularAporte(
      'o1',
      ventaBase({ estadoPago: 'pendiente', origenCuentaPendiente: true, metodoPago: 'Efectivo' }),
    );
    expect(aporte).not.toBeNull();
    expect(aporte?.totalTicketsPendientes).toBe(1);
    expect(aporte?.totalTicketsFlujo).toBe(1);
  });

  it('metodo "por cobrar" tambien la marca pendiente', () => {
    const aporte = calcularAporte(
      'o1',
      ventaBase({ estadoPago: 'pendiente', metodoPago: 'Por cobrar' }),
    );
    expect(aporte?.totalTicketsPendientes).toBe(1);
  });

  it('una pendiente no suma plata inmediata', () => {
    const aporte = calcularAporte(
      'o1',
      ventaBase({ estadoPago: 'pendiente', origenCuentaPendiente: true, metodoPago: 'Efectivo' }),
    );
    // No entro plata todavia: aporta al flujo pero con 0 en efectivo.
    expect(aporte?.efectivo).toBe(0);
    expect(aporte?.totalTicketsPagados).toBe(0);
  });
});

describe('sumarAportes', () => {
  it('acumula por metodo y descarta lo que no aporta', () => {
    const totales = sumarAportes([
      { id: 'o1', venta: ventaBase() },
      { id: 'o2', venta: ventaBase({ metodoPago: 'Tarjeta' }) },
      { id: 'o3', venta: ventaBase({ metodoPago: 'Credito' }) },
      { id: 'o4', venta: ventaBase({ estadoPago: 'anulado' }) },
      { id: 'o5', venta: ventaBase({ arqueado: true }) },
    ]);
    expect(totales).toEqual({
      efectivo: 100_000,
      tarjeta: 100_000,
      transferencia: 0,
      credito: 100_000,
    });
  });
});

describe('agruparCierreForzado', () => {
  it('elige el turno con actividad mas reciente', () => {
    const grupo = agruparCierreForzado(
      [
        {
          id: 'viejo',
          venta: ventaBase({ turnoId: 'TURN-VIEJO', fecha: new Date('2026-01-01T10:00:00Z') }),
        },
        {
          id: 'nuevo',
          venta: ventaBase({ turnoId: 'TURN-NUEVO', fecha: new Date('2026-01-02T10:00:00Z') }),
        },
      ],
      'Centro',
    );
    expect(grupo?.turnoId).toBe('TURN-NUEVO');
    expect(grupo?.ventas).toHaveLength(1);
  });

  it('ignora otras sucursales', () => {
    expect(
      agruparCierreForzado([{ id: 'o1', venta: ventaBase({ sucursal: 'Otra' }) }], 'Centro'),
    ).toBeNull();
  });

  it('devuelve null si no hay tickets pendientes', () => {
    expect(
      agruparCierreForzado([{ id: 'o1', venta: ventaBase({ arqueado: true }) }], 'Centro'),
    ).toBeNull();
  });
});

describe('esCandidatoCierreForzado', () => {
  it('acepta pagado y pendiente, rechaza anulado y rechazado', () => {
    expect(esCandidatoCierreForzado(ventaBase(), 'Centro')).toBe(true);
    expect(esCandidatoCierreForzado(ventaBase({ estadoPago: 'pendiente' }), 'Centro')).toBe(true);
    expect(esCandidatoCierreForzado(ventaBase({ estadoPago: 'anulado' }), 'Centro')).toBe(false);
    expect(esCandidatoCierreForzado(ventaBase({ estadoPago: 'rechazado' }), 'Centro')).toBe(false);
  });
});

describe('agruparProductos', () => {
  it('acumula cantidades y montos por nombre', () => {
    const productos = agruparProductos([
      { venta: { items: [{ nombre: 'Coca', cantidad: 2, precio: 5_000 }] } },
      { venta: { items: [{ nombre: 'Coca', cantidad: 1, precio: 5_000 }] } },
    ]);
    expect(productos['Coca']).toEqual({ cant: 3, total: 15_000 });
  });

  it('prioriza precioAplicado sobre precio', () => {
    const productos = agruparProductos([
      {
        venta: {
          items: [{ nombre: 'Lomito', cantidad: 1, precio: 30_000, precioAplicado: 25_000 }],
        },
      },
    ]);
    expect(productos['Lomito']?.total).toBe(25_000);
  });

  it('un item sin nombre no rompe', () => {
    const productos = agruparProductos([{ venta: { items: [{ cantidad: 1, precio: 100 }] } }]);
    expect(productos['Producto']).toEqual({ cant: 1, total: 100 });
  });
});

describe('fechaHoraTexto: linea APERTURA del ticket de cierre', () => {
  it('formatea dd/mm/yyyy hh:mm en la hora del negocio', () => {
    // 08:30 en Asuncion (UTC-3) equivale a 11:30 UTC.
    expect(fechaHoraTexto(new Date('2026-09-19T11:30:00.000Z'))).toBe('19/09/2026 08:30');
  });

  it('devuelve vacio cuando no hay fecha usable', () => {
    expect(fechaHoraTexto(null)).toBe('');
    expect(fechaHoraTexto(undefined)).toBe('');
    expect(fechaHoraTexto('no-es-fecha')).toBe('');
  });
});

