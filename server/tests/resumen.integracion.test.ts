import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { redis } from '../src/config/redis.js';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { Order } from '../src/models/index.js';
import { obtenerResumenVentas } from '../src/services/reporte.service.js';


const hayBase = process.env.TEST_MONGO === '1';



describe.skipIf(!hayBase)('resumen de ventas contra la base real', () => {
  const app = buildApp();
  const rutaResumen = `${env.API_PREFIX}/orders/resumen`;
  const rutaOrdenes = `${env.API_PREFIX}/orders`;
  const tokenAdmin = jwt.sign(
    { sub: 'uid-test', rol: 'admin', sucursal: 'Centro', nombre: 'Test' },
    env.JWT_SECRET,
    { expiresIn: '5m' },
  );

  beforeAll(async () => {
    
    if (!hayBase) return;
    mongoose.set('bufferTimeoutMS', 2000);
    await connectDatabase();
  }, 30000);

  afterAll(async () => {
    if (!hayBase) return;
    redis.disconnect();
    await disconnectDatabase();
  });

  const suma = (grupos: { total: number }[]): number =>
    grupos.reduce((total, grupo) => total + Number(grupo.total || 0), 0);

  it('la misma plata suma igual por dia, metodo, sucursal y vendedor', async () => {
    const r = await obtenerResumenVentas({});
    expect(suma(r.porDia)).toBeCloseTo(r.totales.ventaTotal, 2);
    expect(suma(r.porMetodo)).toBeCloseTo(r.totales.ventaTotal, 2);
    expect(suma(r.porSucursal)).toBeCloseTo(r.totales.ventaTotal, 2);
    expect(suma(r.porVendedor)).toBeCloseTo(r.totales.ventaTotal, 2);
  }, 30000);

  it('los cinco metodos suman exactamente la venta total', async () => {
    const r = await obtenerResumenVentas({});
    const porBandera =
      r.totales.efectivo + r.totales.tarjeta + r.totales.transferencia + r.totales.credito + r.totales.otros;
    expect(porBandera).toBeCloseTo(r.totales.ventaTotal, 2);
  }, 30000);

  it('no cuenta lo anulado ni lo que no afecta caja', async () => {
    const r = await obtenerResumenVentas({});
    const fueraDeLaVenta = await Order.countDocuments({
      $or: [{ anulado: true }, { cancelado: true }, { noAfectaCaja: true }],
    }).exec();
    const enLaBase = await Order.estimatedDocumentCount().exec();
    /* Lo que entra a la venta no puede superar a todo lo que hay en la base: si el filtro no
       estuviera, este numero se pasaria y el test lo delata. */
    expect(r.totales.tickets).toBeLessThanOrEqual(enLaBase);
    expect(r.totales.tickets + fueraDeLaVenta).toBeLessThanOrEqual(enLaBase);
  }, 30000);

  it('el rango de fechas acota: un mes nunca suma mas que todo el historico', async () => {
    const todo = await obtenerResumenVentas({});
    const mes = await obtenerResumenVentas({
      desde: '2026-01-01T00:00:00.000Z',
      hasta: '2026-01-31T23:59:59.999Z',
    });
    expect(mes.totales.tickets).toBeLessThanOrEqual(todo.totales.tickets);
    expect(mes.totales.ventaTotal).toBeLessThanOrEqual(todo.totales.ventaTotal + 0.01);
  }, 30000);

  it('un rango sin ventas devuelve cero, no un error', async () => {
    const r = await obtenerResumenVentas({
      desde: '1990-01-01T00:00:00.000Z',
      hasta: '1990-01-02T00:00:00.000Z',
    });
    expect(r.totales.tickets).toBe(0);
    expect(r.totales.ventaTotal).toBe(0);
    expect(r.porDia).toHaveLength(0);
  }, 30000);

  it('el endpoint responde con token y rechaza sin token', async () => {
    const con = await request(app).get(rutaResumen).set('Authorization', `Bearer ${tokenAdmin}`);
    expect(con.status).not.toBe(403);
    const sin = await request(app).get(rutaResumen);
    expect(sin.status).toBe(401);
  }, 30000);

  it('offset pagina de verdad: la segunda pagina no repite la primera', async () => {
    const primera = await request(app)
      .get(`${rutaOrdenes}?limit=5&offset=0`)
      .set('Authorization', `Bearer ${tokenAdmin}`);
    const segunda = await request(app)
      .get(`${rutaOrdenes}?limit=5&offset=5`)
      .set('Authorization', `Bearer ${tokenAdmin}`);

    expect(primera.status).toBe(200);
    expect(segunda.status).toBe(200);
    expect(primera.body.data.offset).toBe(0);
    expect(segunda.body.data.offset).toBe(5);

    const idsPrimera = (primera.body.data.items ?? []).map((o: { _id: string }) => String(o._id));
    const idsSegunda = (segunda.body.data.items ?? []).map((o: { _id: string }) => String(o._id));
    if (idsPrimera.length === 0 || idsSegunda.length === 0) return;
    for (const id of idsSegunda) expect(idsPrimera).not.toContain(id);
  }, 30000);
});
