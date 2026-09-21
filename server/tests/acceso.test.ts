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

/* Token valido, firmado igual que auth.service.ts. */
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

  mongoose.set('bufferTimeoutMS', 300);
});

afterAll(async () => {

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


describe('resumen de ventas (/orders/resumen)', () => {
  const ruta = `${env.API_PREFIX}/orders/resumen`;

  /* Token con un rol cualquiera, firmado igual que auth.service.ts. */
  const tokenConRol = (rol: string): string =>
    jwt.sign({ sub: 'uid-rol', rol, sucursal: 'Centro', nombre: 'Test' }, env.JWT_SECRET, {
      expiresIn: '5m',
    });

  const pedirCon = (token: string) =>
    request(app).get(ruta).set('Authorization', `Bearer ${token}`);

  it('sin token responde 401', async () => {
    const res = await request(app).get(ruta);
    expect(res.status).toBe(401);
  });

  it('con token vencido responde 401', async () => {
    const res = await pedirCon(tokenVencido);
    expect(res.status).toBe(401);
  });

  it('un cliente NO puede leer los totales de venta', async () => {
    const res = await pedirCon(tokenConRol('cliente'));
    expect(res.status).toBe(403);
  });

  it('cocina tampoco: son totales de plata', async () => {
    const res = await pedirCon(tokenConRol('cocina'));
    expect(res.status).toBe(403);
  });

  it('cajero, supervisor y admin SI pasan el control de rol (nunca 403)', async () => {
    for (const rol of ['cajero', 'supervisor', 'admin']) {
      const res = await pedirCon(tokenConRol(rol));
      expect(res.status).not.toBe(403);
    }
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

/* Firma un token con el rol pedido. */
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

  
  it('un cajero NO puede escribir la config (403)', async () => {
    const res = await request(app)
      .patch(url)
      .set('Authorization', 'Bearer ' + tokenDe('cajero'))
      .send({ creditoMaximoCliente: 500000 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SIN_PERMISO');
  });

  it('un cliente tampoco (403)', async () => {
    const res = await request(app)
      .patch(url)
      .set('Authorization', 'Bearer ' + tokenDe('cliente'))
      .send({ creditoMaximoCliente: 500000 });
    expect(res.status).toBe(403);
  });

  it('un body vacio no se acepta como un cambio silencioso', async () => {
    const res = await request(app)
      .patch(url)
      .set('Authorization', 'Bearer ' + tokenValido)
      .send({});
    
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(403);
  });

  it('un admin SI pasa el control de rol', async () => {
    const res = await request(app)
      .patch(url)
      .set('Authorization', 'Bearer ' + tokenValido)
      .send({ creditoMaximoCliente: 500000 });
    // Sin Mongo no encuentra el documento de config, pero no puede cortar por rol.
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
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

describe('cierre Z del cajero (/cash-shifts/cerrar)', () => {
  
  const url = `${env.API_PREFIX}/cash-shifts/cerrar`;

  it('sin token responde 401', async () => {
    const res = await request(app).post(url).send({ turnoId: 'T1', cajero: 'Ana' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SIN_TOKEN');
  });

  it('exige turnoId y cajero (400 antes de tocar la base)', async () => {
    for (const body of [{}, { turnoId: 'T1' }, { cajero: 'Ana' }, { turnoId: '  ', cajero: 'Ana' }]) {
      const res = await request(app)
        .post(url)
        .set('Authorization', 'Bearer ' + tokenValido)
        .send(body);
      expect(res.status).toBe(400);
      expect(['MISSING_SHIFT_ID', 'MISSING_CASHIER']).toContain(res.body.code);
    }
  });

  it('rechaza una declaracion con valores no numericos (422)', async () => {
    const res = await request(app)
      .post(url)
      .set('Authorization', 'Bearer ' + tokenValido)
      .send({ turnoId: 'T1', cajero: 'Ana', declaracion: { efectivo: 'mucho' } });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_DECLARATION');
  });

  
  it('un cajero SI puede cerrar su caja (no 403)', async () => {
    const res = await request(app)
      .post(url)
      .set('Authorization', 'Bearer ' + tokenDe('cajero'))
      .send({ turnoId: 'T1', cajero: 'Ana' });
    // Sin Mongo da 500 al buscar el turno, pero no 403: el rol fue aceptado.
    expect(res.status).not.toBe(403);
  });

  it('un supervisor tambien (no 403)', async () => {
    const res = await request(app)
      .post(url)
      .set('Authorization', 'Bearer ' + tokenDe('supervisor'))
      .send({ turnoId: 'T1', cajero: 'Ana' });
    expect(res.status).not.toBe(403);
  });

  it('un cliente NO puede cerrar una caja (403)', async () => {
    const res = await request(app)
      .post(url)
      .set('Authorization', 'Bearer ' + tokenDe('cliente'))
      .send({ turnoId: 'T1', cajero: 'Ana' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SIN_PERMISO');
  });

  it('un rol cocina tampoco (403)', async () => {
    const res = await request(app)
      .post(url)
      .set('Authorization', 'Bearer ' + tokenDe('cocina'))
      .send({ turnoId: 'T1', cajero: 'Ana' });
    expect(res.status).toBe(403);
  });
});

describe('cierre forzado de sucursal (/cash-shifts/forzar-cierre)', () => {
  const url = `${env.API_PREFIX}/cash-shifts/forzar-cierre`;

  it('sin token responde 401', async () => {
    const res = await request(app).post(url).send({ sucursal: 'Centro', motivo: 'x' });
    expect(res.status).toBe(401);
  });

  
  it('un cajero NO puede forzar el cierre (403)', async () => {
    const res = await request(app)
      .post(url)
      .set('Authorization', 'Bearer ' + tokenDe('cajero'))
      .send({ sucursal: 'Centro', motivo: 'se fue sin cerrar' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SIN_PERMISO');
  });

  
  it('un supervisor tampoco (403), aunque si pueda tocar /config/sistema', async () => {
    const res = await request(app)
      .post(url)
      .set('Authorization', 'Bearer ' + tokenDe('supervisor'))
      .send({ sucursal: 'Centro', motivo: 'cierre de fin de dia' });
    expect(res.status).toBe(403);
  });

  it('un rol cocina NO puede (403)', async () => {
    const res = await request(app)
      .post(url)
      .set('Authorization', 'Bearer ' + tokenDe('cocina'))
      .send({ sucursal: 'Centro', motivo: 'x' });
    expect(res.status).toBe(403);
  });

  it('exige sucursal y motivo (400 antes de tocar la base)', async () => {
    const casos: Array<[Record<string, unknown>, string]> = [
      [{}, 'MISSING_SUCURSAL'],
      [{ sucursal: '   ' }, 'MISSING_SUCURSAL'],
      [{ sucursal: 'Centro' }, 'MISSING_MOTIVO'],
      [{ sucursal: 'Centro', motivo: '  ' }, 'MISSING_MOTIVO'],
    ];
    for (const [body, code] of casos) {
      const res = await request(app)
        .post(url)
        .set('Authorization', 'Bearer ' + tokenValido)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(code);
    }
  });

  
  it('dryRun no salta el control de rol', async () => {
    const res = await request(app)
      .post(url)
      .set('Authorization', 'Bearer ' + tokenDe('cajero'))
      .send({ sucursal: 'Centro', motivo: 'simulacion', dryRun: true });
    expect(res.status).toBe(403);
  });

  
  it('dryRun no salta la validacion del body', async () => {
    const res = await request(app)
      .post(url)
      .set('Authorization', 'Bearer ' + tokenValido)
      .send({ dryRun: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_SUCURSAL');
  });

  it('un admin SI pasa el control de rol', async () => {
    const res = await request(app)
      .post(url)
      .set('Authorization', 'Bearer ' + tokenValido)
      .send({
        sucursal: 'Centro',
        motivo: 'cierre de fin de dia',
        declaracion: { fondoInicial: 50_000, efectivo: 120_000, tarjeta: 30_000 },
        dryRun: true,
      });
    // Sin Mongo da 500 al buscar las ordenes, pero no 403: el rol fue aceptado.
    expect(res.status).not.toBe(403);
  });
});

describe('cambio de contraseña de un usuario (/auth/usuarios/:id/reset-password)', () => {
  const url = (id: string): string => `${env.API_PREFIX}/auth/usuarios/${id}/reset-password`;

  it('sin token responde 401', async () => {
    const res = await request(app).post(url('abc')).send({ nueva: 'ClaveSegura123' });
    expect(res.status).toBe(401);
  });

  
  it('un cajero NO puede resetear la contraseña de nadie (403)', async () => {
    const res = await request(app)
      .post(url('abc'))
      .set('Authorization', 'Bearer ' + tokenDe('cajero'))
      .send({ nueva: 'ClaveSegura123' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SIN_PERMISO');
  });

  it('un cliente tampoco (403)', async () => {
    const res = await request(app)
      .post(url('abc'))
      .set('Authorization', 'Bearer ' + tokenDe('cliente'))
      .send({ nueva: 'ClaveSegura123' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SIN_PERMISO');
  });

  it('un admin SI pasa el control de rol', async () => {
    const res = await request(app)
      .post(url('abc'))
      .set('Authorization', 'Bearer ' + tokenValido)
      .send({ nueva: 'ClaveSegura123' });

    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  
  it('un supervisor tambien (400 por body vacio, no 403)', async () => {
    const res = await request(app)
      .post(url('abc'))
      .set('Authorization', 'Bearer ' + tokenDe('supervisor'))
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_NEW_PASSWORD');
  });

  it('exige la contraseña nueva (400 antes de tocar la base)', async () => {
    for (const nueva of [undefined, '', 12_345]) {
      const res = await request(app)
        .post(url('abc'))
        .set('Authorization', 'Bearer ' + tokenValido)
        .send({ nueva });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('MISSING_NEW_PASSWORD');
    }
  });

  
  it('rechaza una contraseña corta (422) sin llegar a la base', async () => {
    const res = await request(app)
      .post(url('abc'))
      .set('Authorization', 'Bearer ' + tokenValido)
      .send({ nueva: 'corta' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PASSWORD_CORTA');
  });
});

describe('apertura de turno de caja (/cash-shifts/abrir)', () => {
  const url = `${env.API_PREFIX}/cash-shifts/abrir`;

  it('sin token responde 401', async () => {
    const res = await request(app).post(url).send({ sucursal: 'Centro', fondoInicial: 0 });
    expect(res.status).toBe(401);
  });

  /* Abrir una caja es manejar plata: un rol que no la maneja no puede. */
  it('un cliente NO puede abrir la caja (403)', async () => {
    const res = await request(app)
      .post(url)
      .set('Authorization', 'Bearer ' + tokenDe('cliente'))
      .send({ sucursal: 'Centro', fondoInicial: 0 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SIN_PERMISO');
  });

  it('cocina tampoco (403)', async () => {
    const res = await request(app)
      .post(url)
      .set('Authorization', 'Bearer ' + tokenDe('cocina'))
      .send({ sucursal: 'Centro', fondoInicial: 0 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SIN_PERMISO');
  });

  it('exige la sucursal (400 antes de tocar la base)', async () => {
    for (const sucursal of [undefined, '', '   ']) {
      const res = await request(app)
        .post(url)
        .set('Authorization', 'Bearer ' + tokenDe('cajero'))
        .send({ sucursal, fondoInicial: 0 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('MISSING_SUCURSAL');
    }
  });

  
  it('un cajero SI pasa el control de rol', async () => {
    const res = await request(app)
      .post(url)
      .set('Authorization', 'Bearer ' + tokenDe('cajero'))
      .send({ sucursal: 'San Benito Cafe Resto Bar', fondoInicial: 100_000 });

    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

describe('cobro de una mesa pendiente (/orders/:id/cerrar-cuenta)', () => {
  const url = (id: string): string => `${env.API_PREFIX}/orders/${id}/cerrar-cuenta`;
  
  const idOrden = '507f1f77bcf86cd799439011';
  const bodyOk = {
    metodoPago: 'Efectivo',
    items: [{ id: 'prod-1', nombre: 'Milanesa', cantidad: 1, precio: 1000, controlado: false }],
  };

  it('sin token responde 401', async () => {
    const res = await request(app).post(url(idOrden)).send(bodyOk);
    expect(res.status).toBe(401);
  });

  
  it('un cliente NO puede cerrar una cuenta (403)', async () => {
    const res = await request(app)
      .post(url(idOrden))
      .set('Authorization', 'Bearer ' + tokenDe('cliente'))
      .send(bodyOk);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SIN_PERMISO');
  });

  it('cocina tampoco (403)', async () => {
    const res = await request(app)
      .post(url(idOrden))
      .set('Authorization', 'Bearer ' + tokenDe('cocina'))
      .send(bodyOk);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SIN_PERMISO');
  });

  it('exige el metodo de pago (400 antes de tocar la base)', async () => {
    for (const metodoPago of [undefined, '', '   ']) {
      const res = await request(app)
        .post(url(idOrden))
        .set('Authorization', 'Bearer ' + tokenValido)
        .send({ ...bodyOk, metodoPago });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('MISSING_METODO_PAGO');
    }
  });

  it('exige al menos un item (400 antes de tocar la base)', async () => {
    for (const items of [undefined, [], 'x']) {
      const res = await request(app)
        .post(url(idOrden))
        .set('Authorization', 'Bearer ' + tokenValido)
        .send({ ...bodyOk, items });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('MISSING_ITEMS');
    }
  });

  
  it('rechaza items a los que les falta el precio (422)', async () => {
    const invalidos = [[{}], [{ nombre: 'sin precio', cantidad: 1 }], [{ nombre: 'x', cantidad: 1, precio: -5 }]];
    for (const items of invalidos) {
      const res = await request(app)
        .post(url(idOrden))
        .set('Authorization', 'Bearer ' + tokenValido)
        .send({ ...bodyOk, items });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
  });

  it('un cajero SI pasa el control de rol', async () => {
    const res = await request(app)
      .post(url(idOrden))
      .set('Authorization', 'Bearer ' + tokenDe('cajero'))
      .send(bodyOk);
    // Sin Mongo la transaccion no arranca, pero no puede cortar por rol.
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('un supervisor tambien pasa el control de rol', async () => {
    const res = await request(app)
      .post(url(idOrden))
      .set('Authorization', 'Bearer ' + tokenDe('supervisor'))
      .send(bodyOk);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

describe('metodos de pago al crear una orden (POST /orders)', () => {
  const url = `${env.API_PREFIX}/orders`;
  const item = { nombre: 'Milanesa', cantidad: 1, precio: 1000 };

  
  it('acepta una cuenta abierta con metodo Por Cobrar (nunca 422)', async () => {
    const res = await request(app)
      .post(url)
      .set('Authorization', 'Bearer ' + tokenDe('cajero'))
      .send({
        sucursal: 'Centro',
        cajero: 'Ana',
        nombreCliente: 'Mesa 1',
        metodoPago: 'Por Cobrar',
        estadoPago: 'pendiente',
        origenCuentaPendiente: true,
        items: [item],
      });
    // Sin Mongo la transaccion no arranca, pero el enum tiene que aceptarlo.
    expect(res.status).not.toBe(422);
  });

  
  it('sigue rechazando un metodo que no existe (422)', async () => {
    const res = await request(app)
      .post(url)
      .set('Authorization', 'Bearer ' + tokenDe('cajero'))
      .send({ sucursal: 'Centro', cajero: 'Ana', metodoPago: 'Bitcoin', items: [item] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('guardar una cuenta abierta sin cobrarla (PATCH /orders/:id/cuenta-pendiente)', () => {
  const url = (id: string): string => `${env.API_PREFIX}/orders/${id}/cuenta-pendiente`;
  const idOrden = '507f1f77bcf86cd799439011';
  const items = [{ id: 'prod-1', nombre: 'Milanesa', cantidad: 2, precio: 1000, controlado: false }];

  it('sin token responde 401', async () => {
    const res = await request(app).patch(url(idOrden)).send({ items });
    expect(res.status).toBe(401);
  });

  
  it('un cliente NO puede tocar una cuenta (403)', async () => {
    const res = await request(app)
      .patch(url(idOrden))
      .set('Authorization', 'Bearer ' + tokenDe('cliente'))
      .send({ items });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SIN_PERMISO');
  });

  it('exige items (400 antes de tocar la base)', async () => {
    const res = await request(app)
      .patch(url(idOrden))
      .set('Authorization', 'Bearer ' + tokenValido)
      .send({ items: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_ITEMS');
  });

  it('un cajero SI pasa el control de rol', async () => {
    const res = await request(app)
      .patch(url(idOrden))
      .set('Authorization', 'Bearer ' + tokenDe('cajero'))
      .send({ items });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});


