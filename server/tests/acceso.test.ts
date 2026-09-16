import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { redis } from '../src/config/redis.js';

/**
 * Control de acceso de la API.
 *
 * Contexto: mientras los datos vivian en Firestore, `firestore.rules` era la
 * barrera. Al migrar a Mongo esa barrera desaparece, y el CRUD generico quedo
 * accesible sin token: cualquiera que alcanzara el dominio podia leer todo y
 * hacer POST /users con rol 'admin'. Estos tests fijan ese comportamiento para
 * que no vuelva a pasar.
 *
 * No hace falta base de datos: un 401 se decide antes de consultar Mongo.
 */
const app = buildApp();

/** Token valido, firmado igual que auth.service.ts. */
const tokenValido = jwt.sign(
  { sub: 'uid-1', rol: 'admin', sucursal: 'Centro', nombre: 'Test' },
  env.JWT_SECRET,
  { expiresIn: '5m' },
);

const tokenVencido = jwt.sign(
  { sub: 'uid-1', rol: 'admin', sucursal: 'Centro', nombre: 'Test' },
  env.JWT_SECRET,
  { expiresIn: '-1s' },
);

beforeAll(() => {
  // Sin Mongo en los tests, una consulta que llegue a la base esperaria 10s por
  // el buffer de Mongoose. Con esto falla en 300ms y el test no se cuelga.
  mongoose.set('bufferTimeoutMS', 300);
});

afterAll(async () => {
  // Sin esto el proceso de test no termina: ioredis deja el handle abierto.
  redis.disconnect();
});

describe('rutas publicas', () => {
  it('/health responde sin token', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { status: 'ok' } });
  });

  it('/auth/login existe y no exige token (responde 400 por body vacio)', async () => {
    const res = await request(app).post(`${env.API_PREFIX}/auth/login`).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_EMAIL');
  });

  it('/public-goals es de lectura publica (no devuelve 401)', async () => {
    const res = await request(app).get(`${env.API_PREFIX}/public-goals`);
    // Sin Mongo da 500, pero lo que importa es que NO corto por falta de token.
    expect(res.status).not.toBe(401);
  });
});

describe('rutas protegidas sin token', () => {
  const sinToken = [
    ['get', '/products'],
    ['get', '/users'],
    ['get', '/orders'],
    ['get', '/audit-logs'],
    ['get', '/cash-shifts'],
    ['get', '/credit-pins'],
    ['get', '/branches'],
  ] as const;

  for (const [metodo, ruta] of sinToken) {
    it(`${metodo.toUpperCase()} ${ruta} responde 401`, async () => {
      const res = await request(app)[metodo](`${env.API_PREFIX}${ruta}`);
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ success: false, code: 'SIN_TOKEN' });
    });
  }

  it('POST /users sin token responde 401 (evita escalar a admin)', async () => {
    const res = await request(app)
      .post(`${env.API_PREFIX}/users`)
      .send({ nombre: 'Intruso', email: 'x@y.z', rol: 'admin' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SIN_TOKEN');
  });

  it('PATCH /products/:id sin token responde 401', async () => {
    const res = await request(app)
      .patch(`${env.API_PREFIX}/products/507f1f77bcf86cd799439011`)
      .send({ precio: 1 });
    expect(res.status).toBe(401);
  });
});

describe('tokens invalidos', () => {
  it('token con basura responde 401 TOKEN_INVALIDO', async () => {
    const res = await request(app)
      .get(`${env.API_PREFIX}/products`)
      .set('Authorization', 'Bearer no-es-un-jwt');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALIDO');
  });

  it('token vencido responde 401', async () => {
    const res = await request(app)
      .get(`${env.API_PREFIX}/products`)
      .set('Authorization', 'Bearer ' + tokenVencido);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALIDO');
  });

  it('header sin el prefijo Bearer responde 401 SIN_TOKEN', async () => {
    const res = await request(app)
      .get(`${env.API_PREFIX}/products`)
      .set('Authorization', tokenValido);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SIN_TOKEN');
  });
});

describe('token valido', () => {
  it('pasa el control de acceso (ya no responde 401)', async () => {
    const res = await request(app)
      .get(`${env.API_PREFIX}/products`)
      .set('Authorization', 'Bearer ' + tokenValido);
    expect(res.status).not.toBe(401);
  });

  it('un GET con token valido tampoco se rechaza por permisos', async () => {
    const res = await request(app)
      .get(`${env.API_PREFIX}/users`)
      .set('Authorization', 'Bearer ' + tokenValido);
    expect(res.status).not.toBe(403);
  });
});

describe('rutas inexistentes', () => {
  /**
   * requiereAuth esta montado a nivel de prefijo (/api/v1), asi que corta ANTES
   * del notFound: una ruta que no existe responde 401 y no 404.
   *
   * Es deliberado: a un cliente sin credenciales no se le revela que rutas
   * existen. Un cliente autenticado si recibe el 404 correcto, que es el caso
   * que importa para depurar desde la app.
   */
  it('sin token responde 401 (no revela que la ruta no existe)', async () => {
    const res = await request(app).get(`${env.API_PREFIX}/no-existe-esta-coleccion`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SIN_TOKEN');
  });

  it('con token valido responde 404 con el contrato de error', async () => {
    const res = await request(app)
      .get(`${env.API_PREFIX}/no-existe-esta-coleccion`)
      .set('Authorization', 'Bearer ' + tokenValido);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, code: 'NOT_FOUND' });
  });
});

/** Firma un token con el rol pedido. */
const tokenDe = (rol: string): string =>
  jwt.sign({ sub: 'uid-1', rol, sucursal: 'Centro', nombre: 'Test' }, env.JWT_SECRET, {
    expiresIn: '5m',
  });

describe('cobro de abonos (/orders/:id/cobro)', () => {
  const url = (id: string): string => `${env.API_PREFIX}/orders/${id}/cobro`;

  it('sin token responde 401', async () => {
    const res = await request(app).post(url('abc')).send({ accion: 'aprobar' });
    expect(res.status).toBe(401);
  });

  it('un rol cliente NO puede mover deuda (403)', async () => {
    const res = await request(app)
      .post(url('abc'))
      .set('Authorization', 'Bearer ' + tokenDe('cliente'))
      .send({ accion: 'aprobar' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SIN_PERMISO');
  });

  it('un cajero SI puede autorizar cobros', async () => {
    const res = await request(app)
      .post(url('abc'))
      .set('Authorization', 'Bearer ' + tokenDe('cajero'))
      .send({ accion: 'aprobar' });
    // Sin Mongo da 500, pero lo que importa es que paso el control de rol.
    expect(res.status).not.toBe(403);
  });

  it('rechaza una accion que no sea aprobar/rechazar (422 antes de tocar la base)', async () => {
    for (const accion of [undefined, '', 'borrar', 'APROBAR']) {
      const res = await request(app)
        .post(url('abc'))
        .set('Authorization', 'Bearer ' + tokenValido)
        .send(accion === undefined ? {} : { accion });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('ACCION_INVALIDA');
    }
  });
});

describe('configuracion global (/config/sistema)', () => {
  const url = `${env.API_PREFIX}/config/sistema`;

  it('leer la config exige token', async () => {
    const res = await request(app).get(url);
    expect(res.status).toBe(401);
  });

  it('un cajero NO puede cambiar la config (403)', async () => {
    const res = await request(app)
      .patch(url)
      .set('Authorization', 'Bearer ' + tokenDe('cajero'))
      .send({ divisas: { USD: 7500 } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SIN_PERMISO');
  });

  it('un cliente tampoco', async () => {
    const res = await request(app)
      .patch(url)
      .set('Authorization', 'Bearer ' + tokenDe('cliente'))
      .send({ limiteCredito: 1 });
    expect(res.status).toBe(403);
  });

  it('un admin SI pasa el control de rol', async () => {
    const res = await request(app)
      .patch(url)
      .set('Authorization', 'Bearer ' + tokenValido)
      .send({ divisas: { USD: 7500 } });
    // Sin Mongo da 500/404, pero no 403: el rol fue aceptado.
    expect(res.status).not.toBe(403);
  });

  it('un body vacio no devuelve 200 (no hay cambio silencioso)', async () => {
    const res = await request(app)
      .patch(url)
      .set('Authorization', 'Bearer ' + tokenValido)
      .send({});
    // Con Mongo responde 422 SIN_CAMBIOS; sin Mongo, 500 en la consulta previa
    // que busca el documento. Lo que se fija aca es lo importante: NUNCA
    // responde 200 sin haber aplicado nada.
    expect(res.status).not.toBe(200);
  });
});

describe('marcar ticket como abonado (/orders/:id/abonar)', () => {
  const url = (id: string): string => `${env.API_PREFIX}/orders/${id}/abonar`;

  it('sin token responde 401', async () => {
    const res = await request(app).post(url('abc')).send({ motivo: 'x' });
    expect(res.status).toBe(401);
  });

  it('exige el motivo (400 antes de tocar la base)', async () => {
    for (const motivo of [undefined, '', '   ']) {
      const res = await request(app)
        .post(url('abc'))
        .set('Authorization', 'Bearer ' + tokenValido)
        .send(motivo === undefined ? {} : { motivo });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('MISSING_MOTIVO');
    }
  });

  it('un rol cocina NO puede excluir tickets del arqueo (403)', async () => {
    const res = await request(app)
      .post(url('abc'))
      .set('Authorization', 'Bearer ' + tokenDe('cocina'))
      .send({ motivo: 'paga el encargado' });
    expect(res.status).toBe(403);
  });
});
