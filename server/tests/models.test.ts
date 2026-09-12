import { describe, expect, it } from 'vitest';
import {
  AuditLog,
  Branch,
  CashShift,
  Category,
  Currency,
  Order,
  OrderItem,
  Product,
  User,
} from '../src/models/index.js';

// Garantia de migracion limpia: la coleccion Mongo debe conservar el nombre de Firestore.
describe('nombres de coleccion (paridad Firestore -> MongoDB)', () => {
  const models = {
    users: User,
    branches: Branch,
    currencies: Currency,
    categories: Category,
    products: Product,
    cash_shifts: CashShift,
    orders: Order,
    order_items: OrderItem,
    audit_logs: AuditLog,
  } as const;

  it.each(Object.entries(models))('%s se modela en la coleccion %s', (collection, model) => {
    expect(model.collection.name).toBe(collection);
  });
});

describe('Producto', () => {
  it('valida un producto minimo valido', () => {
    const product = new Product({ nombre: 'Lomito', precio: 25_000 });
    expect(product.validateSync()).toBeUndefined();
    expect(product.estado).toBe('Activo');
    expect(product.agotado).toBe(false);
  });

  it('exige nombre y precio', () => {
    const product = new Product({});
    const error = product.validateSync();
    expect(error?.errors['nombre']).toBeDefined();
    expect(error?.errors['precio']).toBeDefined();
  });

  it('rechaza stock negativo y estado fuera del enum', () => {
    const product = new Product({
      nombre: 'Papas',
      precio: 10_000,
      stock: -5,
      estado: 'Agotadisimo',
    });
    const error = product.validateSync();
    expect(error?.errors['stock']).toBeDefined();
    expect(error?.errors['estado']).toBeDefined();
  });
});

describe('Order + OrderItem', () => {
  const itemBase = {
    id: '65f1c0a1b2c3d4e5f6071829',
    uniqueId: 1774727178130,
    nombre: 'COCA COLA 1 LTS',
    precio: 15_000,
    categoria: 'Bebida',
    cantidad: 1,
    controlado: true,
    descuento: 0,
    descuentoVip: 0,
    descuentoBogo: 0,
    promocionBogo: false,
    codigo: '',
    icono: 'fa-bottle-water',
    obsProd: '',
  };

  it('crea un ticket con items embebidos y valores por defecto', () => {
    const order = new Order({
      ticket_id: 'T-693213',
      sucursal: 'San Benito Cafe Resto Bar',
      total: 15_000,
      items: [itemBase],
    });

    expect(order.validateSync()).toBeUndefined();
    expect(order.estadoPago).toBe('pendiente');
    expect(order.metodoPago).toBe('Efectivo');
    expect(order.estadoCocina).toBe('pendiente');
    expect(order.tipoTransaccion).toBe('venta_comida');
    expect(order.cliente).toBe('ocasional');
    expect(order.arqueado).toBe(false);
  });

  it('exige la cantidad minima por item', () => {
    const order = new Order({
      ticket_id: 'T-1',
      sucursal: 'Cafeteria Chicolin',
      total: 0,
      items: [{ ...itemBase, cantidad: 0 }],
    });
    expect(order.validateSync()?.errors['items.0.cantidad']).toBeDefined();
  });

  it('exige ticket_id, total y sucursal', () => {
    const order = new Order({});
    const error = order.validateSync();
    expect(error?.errors['ticket_id']).toBeDefined();
    expect(error?.errors['total']).toBeDefined();
    expect(error?.errors['sucursal']).toBeDefined();
  });

  it('rechaza un metodo de pago fuera del enum observado', () => {
    const order = new Order({
      ticket_id: 'T-2',
      sucursal: 'Cafeteria Chicolin',
      total: 1_000,
      metodoPago: 'Bitcoin',
    });
    expect(order.validateSync()?.errors['metodoPago']).toBeDefined();
  });

  it('mapea el detalle de cobro en moneda extranjera', () => {
    const order = new Order({
      ticket_id: 'T-3',
      sucursal: 'Cafeteria Chicolin',
      total: 15_000,
      detalleEfectivo: {
        monedaCobro: 'USD',
        tasaCambioAplicada: 5_800,
        montoRecibidoMoneda: 3,
        montoRecibidoGs: 17_400,
        vueltoGs: 2_400,
      },
    });
    expect(order.validateSync()).toBeUndefined();
    expect(order.detalleEfectivo?.monedaCobro).toBe('USD');
    expect(order.detalleEfectivo?.vueltoGs).toBe(2_400);
  });

  it('la coleccion order_items conserva el vinculo al ticket', () => {
    const item = new OrderItem({
      ...itemBase,
      orderId: '65f1c0a1b2c3d4e5f607182a',
      productoId: 'ysei6UDGoUvZVWBRFAAl',
      subtotal: 15_000,
      ticket_id: 'T-693213',
      sucursal: 'San Benito Cafe Resto Bar',
    });
    expect(item.validateSync()).toBeUndefined();
    expect(item.collection.name).toBe('order_items');
    expect(item.orderId?.toString()).toBe('65f1c0a1b2c3d4e5f607182a');
  });
});

describe('CashShift', () => {
  it('inicia en estado abierto con totales planos en cero', () => {
    const shift = new CashShift({ turnoId: 'TURN-MrLinRestaur-1782760205099-714', sucursal: 'Mr Lin Restaurante' });
    expect(shift.validateSync()).toBeUndefined();
    expect(shift.estadoTurno).toBe('abierto');
    expect(shift.efectivo).toBe(0);
    expect(shift.tarjetaPOS).toBe(0);
    expect(shift.transferencia).toBe(0);
    expect(shift.credito).toBe(0);
    expect(shift.ventaTotalBruta).toBe(0);
    expect(shift.totalTickets).toBe(0);
    expect(shift.origen).toBe('pos');
  });

  it('requiere turnoId y sucursal', () => {
    const error = new CashShift({}).validateSync();
    expect(error?.errors['turnoId']).toBeDefined();
    expect(error?.errors['sucursal']).toBeDefined();
  });

  it('rechaza estados fuera del enum', () => {
    const shift = new CashShift({ turnoId: 'T-1', sucursal: 'San Benito', estadoTurno: 'abiert' });
    expect(shift.validateSync()?.errors['estadoTurno']).toBeDefined();
  });

  it('indexa el turno abierto por sucursal con unicidad parcial', () => {
    const partial = CashShift.schema
      .indexes()
      .find(([, options]) => options.partialFilterExpression !== undefined);
    expect(partial).toBeDefined();
    expect(partial?.[1].unique).toBe(true);
    expect(partial?.[1].partialFilterExpression).toEqual({ estadoTurno: 'abierto' });
  });
});

describe('AuditLog', () => {
  it('acepta un registro de anulacion del legado', () => {
    const log = new AuditLog({
      tipo: 'anulacion_ticket',
      ventaId: '003Jljv7OSqMjmpcAvgm',
      ticketId: 'T-693213',
      nombreCliente: 'Fisico 1',
      motivo: 'Cliente solicita anulacion',
      totalAntes: 15_000,
      totalDespues: 0,
      origen: 'dashboard',
    });
    expect(log.validateSync()).toBeUndefined();
    expect(log.totalAntes).toBe(15_000);
    expect(log.fecha).toBeInstanceOf(Date);
  });

  it('acepta un ticket interno de soporte (ex systemAlerts)', () => {
    const log = new AuditLog({
      tipo: 'ticket_soporte',
      mensaje: 'No sincroniza el catalogo',
      nivel: 'error',
      estado: 'abierto',
      detalle: { coleccion: 'products' },
    });
    expect(log.validateSync()).toBeUndefined();
    expect(log.nivel).toBe('error');
  });

  it('exige el discriminador tipo', () => {
    expect(new AuditLog({}).validateSync()?.errors['tipo']).toBeDefined();
  });

  it('declara retencion TTL de 5 anios y esquema permisivo para el legado', () => {
    const ttl = AuditLog.schema
      .indexes()
      .find(([, options]) => options.expireAfterSeconds === 157_680_000);
    expect(ttl).toBeDefined();
    expect(ttl?.[0]).toEqual({ fecha: 1, tipo: 1 });
    // strict true (no throw): el legado puede traer campos no declarados.
    expect(AuditLog.schema.options.strict).toBe(true);
    expect(AuditLog.schema.options.collection).toBe('audit_logs');
  });
});
