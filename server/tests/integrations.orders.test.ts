import { describe, expect, it } from 'vitest';
import { createWebOrderInputSchema } from '../src/schemas/orderIntegration.schema.js';
import {
  componerObservacion,
  itemDeCatalogo,
  normalizarTexto,
  ORIGEN_WEB,
} from '../src/services/ordenIntegracion.service.js';

/* Pedidos web: se prueba la parte que decide, sin base de datos.
   La creacion real de la orden la cubre la suite del POS (order.service). */

const base = { items: [{ nombre: 'El Galeon Repleto', cantidad: 1 }] };

describe('payload del pedido web', () => {
  it('descarta el precio que manda el navegador', () => {
    /* El precio lo resuelve el catalogo en el servidor. Si esto empezara a
       viajar, cualquiera podria pedir por 0 Gs. desde la consola del navegador. */
    const parsed = createWebOrderInputSchema.parse({
      items: [{ nombre: 'Hamburguesa', cantidad: 2, precio: 0, descuento: 999999 }],
    });

    expect(parsed.items[0]).not.toHaveProperty('precio');
    expect(parsed.items[0]).not.toHaveProperty('descuento');
  });

  it('aplica los defaults cuando la web no manda nada opcional', () => {
    const parsed = createWebOrderInputSchema.parse(base);

    expect(parsed.modalidad).toBe('local');
    expect(parsed.cliente).toBe('');
    expect(parsed.telefono).toBe('');
    expect(parsed.direccionEntrega).toBe('');
    expect(parsed.observacion).toBe('');
    expect(parsed.items[0]?.obsProd).toBe('');
    expect(parsed.sucursal).toBeUndefined();
  });

  it('acepta solo las modalidades conocidas', () => {
    expect(createWebOrderInputSchema.safeParse({ ...base, modalidad: 'delivery' }).success).toBe(true);
    expect(createWebOrderInputSchema.safeParse({ ...base, modalidad: 'rappi' }).success).toBe(false);
  });

  it('rechaza un pedido sin items', () => {
    expect(createWebOrderInputSchema.safeParse({ items: [] }).success).toBe(false);
  });

  it('rechaza cantidades fuera de rango', () => {
    const item = (cantidad: number): { items: { nombre: string; cantidad: number }[] } => ({
      items: [{ nombre: 'Pizza', cantidad }],
    });
    expect(createWebOrderInputSchema.safeParse(item(0)).success).toBe(false);
    expect(createWebOrderInputSchema.safeParse(item(1.5)).success).toBe(false);
    expect(createWebOrderInputSchema.safeParse(item(100)).success).toBe(false);
    expect(createWebOrderInputSchema.safeParse(item(99)).success).toBe(true);
  });

  it('acota la cantidad de items para que un pedido no bloquee el KDS', () => {
    const muchos = Array.from({ length: 51 }, () => ({ nombre: 'Pizza', cantidad: 1 }));
    expect(createWebOrderInputSchema.safeParse({ items: muchos }).success).toBe(false);
  });
});

describe('traduccion del catalogo al ticket', () => {
  it('compara nombres sin tildes ni mayusculas', () => {
    expect(normalizarTexto('El Galeón Repleto')).toBe('EL GALEON REPLETO');
    expect(normalizarTexto('  pizza   de  lomito ')).toBe('PIZZA DE LOMITO');
    expect(normalizarTexto(null)).toBe('');
  });

  it('toma el precio del producto y no aplica descuentos', () => {
    const item = itemDeCatalogo(
      { _id: 'abc123', nombre: 'Pizza', precio: 60000, categoria: '', icono: '', controlado: true },
      2,
      'sin orégano',
    );

    expect(item).toMatchObject({
      id: 'abc123',
      nombre: 'Pizza',
      cantidad: 2,
      precio: 60000,
      categoria: 'Sin Categoria',
      icono: 'fa-box',
      controlado: true,
      descuento: 0,
      descuentoVip: 0,
      descuentoBogo: 0,
      promocionBogo: false,
      obsProd: 'sin orégano',
    });
  });

  it('deja los productos no controlados sin descuento de stock', () => {
    expect(itemDeCatalogo({ _id: 'x', nombre: 'Gaseosa' }, 1, '').controlado).toBe(false);
  });
});

describe('observacion que ve la caja', () => {
  it('deja el origen y la modalidad a la vista', () => {
    const texto = componerObservacion(
      createWebOrderInputSchema.parse({ ...base, cliente: 'Ana', telefono: '0973', modalidad: 'retiro' }),
    );

    expect(texto.startsWith(ORIGEN_WEB)).toBe(true);
    expect(texto).toContain('retiro');
    expect(texto).toContain('Ana');
    expect(texto).toContain('Tel 0973');
  });

  it('solo incluye la direccion cuando es delivery', () => {
    const conDireccion = { ...base, direccionEntrega: 'Av. Mcal Lopez 123' };

    const retiro = componerObservacion(createWebOrderInputSchema.parse({ ...conDireccion, modalidad: 'retiro' }));
    const delivery = componerObservacion(createWebOrderInputSchema.parse({ ...conDireccion, modalidad: 'delivery' }));

    expect(retiro).not.toContain('Av. Mcal Lopez');
    expect(delivery).toContain('Dir Av. Mcal Lopez 123');
  });

  it('respeta el tope de 400 caracteres del schema de ordenes', () => {
    const texto = componerObservacion(
      createWebOrderInputSchema.parse({ ...base, observacion: 'x'.repeat(400) }),
    );

    expect(texto.length).toBeLessThanOrEqual(400);
  });
});
