import { beforeAll, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import mongoose from 'mongoose';
import { Order, Product, Setting, User } from '../src/models/index.js';
import { construirFiltroAuditoria } from '../src/routes/audit.routes.js';
import { construirFiltro } from '../src/utils/resource.factory.js';
import { filtroPorId } from '../src/utils/mongoId.js';

/**
 * DOS MITADES DEL MISMO PROBLEMA
 *
 * 1) Los filtros PROPIOS tienen que castear. Durante un tiempo no lo hacian: el
 *    `sanitizeFilter` global de Mongoose envuelve en `$eq` cualquier valor con claves que
 *    empiecen con `$`, asi que `{ _id: { $in: [...] } }` se convertia en
 *    `{ _id: { $eq: { $in: [...] } } }` y el casteo intentaba convertir el OPERADOR a ObjectId.
 *    De ahi salio el 400 del cierre forzado:
 *      Cast to ObjectId failed for value "{'$in': [...]}" at path "_id" for model "Order"
 *    La trampa era la misma para `$ne`, `$gte`/`$lte` y `$exists` (por eso el `$nor` y los
 *    `$and` del arqueo, que quedaron como parches sintomaticos) y para el `$in` que arma el
 *    CRUD generico cuando un campo llega con mas de un valor. El flag se apago en
 *    config/database.ts, y estos casos lo fijan SIN BASE: `_castConditions()` es el punto
 *    exacto donde Mongoose aplicaba el envoltorio y casteaba.
 *
 * 2) El BORDE tiene que seguir defendido. `sanitizeFilter` tapaba —de rebote y rompiendo todo
 *    lo demas— la inyeccion de operadores NoSQL que entra por query params: `?rol[$ne]=admin`
 *    no llega como texto, el parser `qs` de Express lo convierte en el OBJETO `{ $ne: 'admin' }`.
 *    Al apagar el flag, esa defensa pasa a ser nuestra: los filtros que leen `req.query` a mano
 *    aceptan solo strings. Estos casos fijan ese contrato.
 */


const castearFiltro = (consulta: unknown): Record<string, unknown> => {
  const query = consulta as {
    _castConditions: () => void;
    getFilter: () => Record<string, unknown>;
  };
  query._castConditions();
  return query.getFilter();
};


const operador = (filtro: Record<string, unknown>, campo: string, op: string): unknown =>
  (filtro[campo] as Record<string, unknown> | undefined)?.[op];

beforeAll(() => {
  
  mongoose.set('strictQuery', true);
});

describe('los filtros propios con operadores castean', () => {
  it('cierre forzado: { _id: { $in: [...] } } en updateMany — era el 400 de produccion', () => {
    const ids = ['6aa580a640040358201a17a6', '6aa580c840040358201a1bc5'];

    const filtro = castearFiltro(
      Order.updateMany({ _id: { $in: ids } }, { $set: { arqueado: true } }),
    );
    const en = operador(filtro, '_id', '$in') as mongoose.Types.ObjectId[];

    expect(Object.keys(filtro['_id'] as object)).toEqual(['$in']);
    expect(en.map((id) => String(id))).toEqual(ids);
  });

  it('cierre normal: el $and envuelve al $or del arqueo y el $nor queda intacto', () => {
    const filtro = castearFiltro(
      Order.find({
        turnoId: 'turno-1',
        $nor: [{ estadoPago: 'anulado' }],
        $and: [{ $or: [{ noAfectaCaja: false }, { noAfectaCaja: null }] }],
      }),
    );

    expect(filtro['turnoId']).toBe('turno-1');
    expect(filtro['$nor']).toEqual([{ estadoPago: 'anulado' }]);
    expect(filtro['$and']).toEqual([{ $or: [{ noAfectaCaja: false }, { noAfectaCaja: null }] }]);
  });

  it('cierre forzado: el $or de los no arqueados sobrevive al casteo', () => {
    const filtro = castearFiltro(
      Order.find({
        sucursal: 'Centro',
        $and: [{ $or: [{ arqueado: false }, { arqueado: null }] }],
      }),
    );

    expect(filtro['sucursal']).toBe('Centro');
    expect(filtro['$and']).toEqual([{ $or: [{ arqueado: false }, { arqueado: null }] }]);
  });

  it('filtroPorId + un $or propio: el $and deja las DOS condiciones', () => {
    const id = '65f1c0a1b2c3d4e5f6071829';

    const filtro = castearFiltro(
      Order.find({ ...filtroPorId(id), $and: [{ $or: [{ arqueado: false }, { arqueado: null }] }] }),
    );
    const alternativas = filtro['$or'] as Record<string, unknown>[];


    expect(String(alternativas[0]?.['_id'])).toBe(id);
    expect(filtro['$and']).toEqual([{ $or: [{ arqueado: false }, { arqueado: null }] }]);
  });

  it('rango de fechas de /orders: { fecha: { $gte, $lte } }', () => {
    const desde = new Date('2026-09-01T00:00:00.000Z');
    const hasta = new Date('2026-09-30T23:59:59.999Z');

    const filtro = castearFiltro(Order.find({ fecha: { $gte: desde, $lte: hasta } }));

    expect(filtro['fecha']).toEqual({ $gte: desde, $lte: hasta });
  });

  it('pago de deuda: el $gte convive con el $or de filtroPorId', () => {
    const id = '65f1c0a1b2c3d4e5f6071829';

    const filtro = castearFiltro(
      User.findOneAndUpdate({ ...filtroPorId(id), deuda: { $gte: 999 } }, { $inc: { deuda: -1000 } }),
    );
    const alternativas = filtro['$or'] as Record<string, unknown>[];

    expect(filtro['deuda']).toEqual({ $gte: 999 });
    expect(String(alternativas[0]?.['_id'])).toBe(id);
    expect(alternativas[1]).toEqual({ legacyId: id });
  });

  it('stock: { _id: {$in}, controlado: true, stock: {$gte} }', () => {
    const ids = ['65f1c0a1b2c3d4e5f6071829'];

    const filtro = castearFiltro(
      Product.updateMany(
        { _id: { $in: ids }, controlado: true, stock: { $gte: 3 } },
        { $inc: { stock: -3 } },
      ),
    );

    expect(Object.keys(filtro['_id'] as object)).toEqual(['$in']);
    expect(filtro['controlado']).toBe(true);
    expect(filtro['stock']).toEqual({ $gte: 3 });
  });

  it('config: { divisas: { $exists: true } }', () => {
    const filtro = castearFiltro(Setting.findOne({ divisas: { $exists: true } }));

    expect(filtro['divisas']).toEqual({ $exists: true });
  });

  it('$ne vuelve a ser usable, sin el rodeo de $nor', () => {
    const filtro = castearFiltro(Order.find({ estadoPago: { $ne: 'anulado' } }));

    expect(filtro['estadoPago']).toEqual({ $ne: 'anulado' });
  });
});

describe('el borde sigue defendido: un query param no puede inyectar operadores', () => {
  
  const filtroDelCrud = (query: Record<string, unknown>) =>
    construirFiltro<unknown>(query as unknown as Request['query'], {
      filtros: ['rol', 'sucursal'],
      campoBusqueda: 'nombre',
    });

  it('resource.factory: descarta el objeto que arma qs con ?rol[$ne]=admin', () => {
    expect(filtroDelCrud({ rol: { $ne: 'admin' } })).toEqual({});
  });

  it('resource.factory: descarta un $or entero que venga por query param', () => {
    expect(filtroDelCrud({ sucursal: { $or: [{ $ne: 'Centro' }] } })).toEqual({});
  });

  it('resource.factory: el multi-valor legitimo sigue siendo $in', () => {
    expect(filtroDelCrud({ sucursal: 'Centro,Este' })).toEqual({
      sucursal: { $in: ['Centro', 'Este'] },
    });
  });

  it('resource.factory: la busqueda libre escapa el regex', () => {
    expect(filtroDelCrud({ q: 'a.*b' })).toEqual({ nombre: { $regex: 'a\\.\\*b', $options: 'i' } });
  });

  it('auditoria: solo entran los filtros que son texto', () => {
    expect(construirFiltroAuditoria({ tipo: { $ne: 'cierre_caja' } })).toEqual({});
    expect(construirFiltroAuditoria({ desde: { $gte: '2026-01-01' } })).toEqual({});
    expect(construirFiltroAuditoria({ nivel: 'error', limit: 50 })).toEqual({ nivel: 'error' });
  });

  it('auditoria: los filtros legitimos siguen entrando, con el alias severidad', () => {
    expect(
      construirFiltroAuditoria({
        tipo: 'cierre_caja',
        sucursal: 'Centro',
        severidad: 'alta',
        desde: '2026-09-01T00:00:00.000Z',
      }),
    ).toEqual({
      tipo: 'cierre_caja',
      sucursal: 'Centro',
      nivel: 'alta',
      fecha: { $gte: new Date('2026-09-01T00:00:00.000Z') },
    });
  });
});

