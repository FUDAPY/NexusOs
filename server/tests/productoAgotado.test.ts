import { describe, expect, it } from 'vitest';
import {
  Product,
  aplicarAgotado,
  calcularAgotado,
  comoDocumentoStock,
  requiereLecturaParaAgotado,
} from '../src/models/Product.js';

/* `agotado` es derivado de (controlado, stock) y hasta hoy solo lo definia
   `pre('save')`. Cualquier escritura que no pasara por `save()` lo dejaba
   desactualizado: reponer stock desde el formulario no lo sacaba de Agotado, y
   OrbitaOs seguia recibiendo `agotado: true` en GET /integrations/stock.
   Estos tests fijan la REGLA y como se aplica sobre una escritura, sin base:
   el cableado del hook lo hace Mongoose y para eso si haria falta un Mongo real. */

describe('calcularAgotado (la regla)', () => {
  it('marca agotado solo si esta controlado y no queda stock', () => {
    expect(calcularAgotado(true, 0)).toBe(true);
    expect(calcularAgotado(true, -1)).toBe(true);
    expect(calcularAgotado(true, 1)).toBe(false);
    expect(calcularAgotado(false, 0)).toBe(false);
    expect(calcularAgotado(false, 10)).toBe(false);
  });

  it('trata el stock ausente como 0 (default del esquema)', () => {
    expect(calcularAgotado(true, undefined)).toBe(true);
    expect(calcularAgotado(false, undefined)).toBe(false);
  });

  it('acepta el stock como texto numerico, que es lo que trae un PATCH', () => {
    expect(calcularAgotado(true, '0')).toBe(true);
    expect(calcularAgotado(true, '5')).toBe(false);
  });

  it('no marca agotado con un controlado que no sea booleano', () => {
    expect(calcularAgotado('true', 0)).toBe(false);
    expect(calcularAgotado(1, 0)).toBe(false);
    expect(calcularAgotado(undefined, 0)).toBe(false);
  });
});

describe('comoDocumentoStock', () => {
  it('deja pasar objetos simples', () => {
    expect(comoDocumentoStock({ stock: 1, controlado: true })).toEqual({ stock: 1, controlado: true });
  });

  it('cualquier otra cosa se trata como "no hay documento"', () => {
    expect(comoDocumentoStock(null)).toBeNull();
    expect(comoDocumentoStock(undefined)).toBeNull();
    expect(comoDocumentoStock([])).toBeNull();
    expect(comoDocumentoStock([{ stock: 1 }])).toBeNull();
    expect(comoDocumentoStock('texto')).toBeNull();
  });
});

describe('aplicarAgotado sobre escrituras', () => {
  const setDe = (salida: unknown): Record<string, unknown> =>
    ((salida as Record<string, unknown>)['$set'] ?? {}) as Record<string, unknown>;

  it('deriva con los dos campos en el $set, sin necesitar ninguna lectura', () => {
    const escritura = { $set: { stock: 0, controlado: true, nombre: 'Pilsen' } };
    expect(requiereLecturaParaAgotado(escritura)).toBe(false);

    const salida = aplicarAgotado(escritura, undefined);
    expect(salida).not.toBeNull();
    const set = setDe(salida);
    expect(set['agotado']).toBe(true);
    expect(set['nombre']).toBe('Pilsen');
  });

  it('reponer stock lo devuelve a false (el caso que rompia)', () => {
    expect(setDe(aplicarAgotado({ $set: { stock: 12, controlado: true } }, undefined))['agotado'])
      .toBe(false);
  });

  it('lee el documento cuando solo viene stock', () => {
    const escritura = { $set: { stock: 0 } };
    expect(requiereLecturaParaAgotado(escritura)).toBe(true);

    expect(aplicarAgotado(escritura, undefined)).toBeNull();
    expect(aplicarAgotado(escritura, null)).toBeNull();
    expect(setDe(aplicarAgotado(escritura, { controlado: true, stock: 9 }))['agotado']).toBe(true);
    expect(setDe(aplicarAgotado(escritura, { controlado: false, stock: 9 }))['agotado']).toBe(false);
  });

  it('lee el documento cuando solo viene controlado', () => {
    const escritura = { $set: { controlado: false } };
    expect(requiereLecturaParaAgotado(escritura)).toBe(true);

    expect(setDe(aplicarAgotado(escritura, { controlado: true, stock: 0 }))['agotado']).toBe(false);
  });

  it('no toca escrituras que no modifican stock ni controlado', () => {
    expect(requiereLecturaParaAgotado({ $set: { nombre: 'Pilsen' } })).toBe(false);
    expect(aplicarAgotado({ $set: { nombre: 'Pilsen' } }, undefined)).toBeNull();
    expect(aplicarAgotado({ $set: { agotado: true } }, undefined)).toBeNull();
    expect(aplicarAgotado({ $unset: { imagen: '' } }, undefined)).toBeNull();
  });

  it('se salta los pipelines: ahi ya deriva el propio update', () => {
    const pipeline = [{ $set: { agotado: { $and: [{ $eq: ['$controlado', true] }] } } }];
    expect(requiereLecturaParaAgotado(pipeline)).toBe(false);
    expect(aplicarAgotado(pipeline, undefined)).toBeNull();
  });

  it('se salta el $inc de la venta, que lo corrige order.service aparte', () => {
    expect(requiereLecturaParaAgotado({ $inc: { stock: -1 } })).toBe(false);
    expect(aplicarAgotado({ $inc: { stock: -1 } }, undefined)).toBeNull();
  });

  it('conserva los demas operadores de la escritura', () => {
    const salida = aplicarAgotado(
      { $set: { stock: 0, controlado: true }, $unset: { imagen: '' } },
      undefined,
    );
    expect((salida as Record<string, unknown>)['$unset']).toEqual({ imagen: '' });
  });

  it('no deriva sobre un stock ilegible: deja el valor anterior como estaba', () => {
    expect(aplicarAgotado({ $set: { stock: 'abc', controlado: true } }, undefined)).toBeNull();
    expect(aplicarAgotado({ $set: { stock: null, controlado: true } }, undefined)).toBeNull();
  });

  it('pisa un agotado mandado a mano: es derivado, no lo escribe el cliente', () => {
    const salida = aplicarAgotado(
      { $set: { stock: 5, controlado: true, agotado: true } },
      undefined,
    );
    expect(setDe(salida)['agotado']).toBe(false);
  });
});

describe('indice unico de codigo', () => {
  it('esta declarado como unico y parcial', () => {
    const indice = Product.schema
      .indexes()
      .find(([, opciones]) => opciones?.name === 'codigo_unico');

    expect(indice).toBeDefined();
    if (indice === undefined) return;

    const [claves, opciones] = indice;
    expect(claves).toEqual({ codigo: 1 });
    expect(opciones?.unique).toBe(true);
    /* Parcial y no sparse: inventario.html manda `codigo: null` al vaciar el campo
       y en Mongo el indice unico COMUN si indexa los `null`. Con el filtro solo
       entran codigos de verdad, asi que todos los productos sin codigo conviven. */
    expect(opciones?.partialFilterExpression).toEqual({ codigo: { $type: 'string', $gt: '' } });
  });
});
