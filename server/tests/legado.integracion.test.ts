import { describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';

/**
 * INTEGRACION DEL PUENTE AL SISTEMA VIEJO: pega contra la Firestore REAL.
 *
 * POR QUE CONTRA LA REAL
 * Lo que se prueba aca es la lectura de Firestore (la consulta, el service account, la
 * forma de los documentos). Con un mock no se probaria nada de eso: es justo lo que
 * cambia entre el sistema viejo y Mongo.
 *
 * NO ESCRIBE NADA. Ni en Firestore ni en Mongo: son dos GET de solo lectura.
 *
 * COMO SE CORRE
 *   npm test                          sin TEST_LEGADO=1 se saltea: la suite normal no cambia
 *   $env:TEST_LEGADO=1; npx vitest run tests/legado.integracion.test.ts
 *   (en produccion, dentro del contenedor del API, con la credencial montada)
 */
const hayLegado = process.env.TEST_LEGADO === '1' && Boolean(env.FIREBASE_SERVICE_ACCOUNT_PATH || env.FIREBASE_SERVICE_ACCOUNT_JSON);

describe.skipIf(!hayLegado)('puente al sistema viejo (/legado)', () => {
  const app = buildApp();
  const rutaTurnos = `${env.API_PREFIX}/legado/turnos-abiertos`;
  const rutaVentas = `${env.API_PREFIX}/legado/ventas`;
  const rutaEstado = `${env.API_PREFIX}/legado/estado`;
  const tokenAdmin = jwt.sign(
    { sub: 'uid-test', rol: 'admin', sucursal: 'Centro', nombre: 'Test' },
    env.JWT_SECRET,
    { expiresIn: '5m' },
  );

  it('sin token no se puede leer el sistema viejo', async () => {
    const r = await request(app).get(rutaTurnos);
    expect(r.status).toBe(401);
  });

  it('devuelve los turnos abiertos, uno por sucursal, con la fecha en ISO', async () => {
    const r = await request(app).get(rutaTurnos).set('Authorization', `Bearer ${tokenAdmin}`);

    expect(r.status).toBe(200);
    const turnos = r.body.data.turnos as { turnoId: string; sucursal: string; fechaApertura: string; resumen: { totalTickets: number } }[];
    expect(Array.isArray(turnos)).toBe(true);

    // Una sola entrada por sucursal: el sistema viejo deja turnos abiertos sin cerrar.
    const sucursales = turnos.map((t) => t.sucursal.toLowerCase());
    expect(new Set(sucursales).size).toBe(sucursales.length);

    for (const turno of turnos) {
      expect(turno.turnoId.length).toBeGreaterThan(0);
      // ISO, no el `{_seconds}` de Firestore: el navegador no entiende ese objeto.
      expect(turno.fechaApertura).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(Number.isFinite(turno.resumen.totalTickets)).toBe(true);
    }
  });

  it('devuelve los tickets del turno con los montos calculados', async () => {
    const turnos = await request(app).get(rutaTurnos).set('Authorization', `Bearer ${tokenAdmin}`);
    const turno = (turnos.body.data.turnos as { turnoId: string }[])[0];
    expect(turno).toBeDefined();

    const r = await request(app)
      .get(rutaVentas)
      .query({ turnoId: turno?.turnoId })
      .set('Authorization', `Bearer ${tokenAdmin}`);

    expect(r.status).toBe(200);
    const { tickets, items, totales } = r.body.data as {
      tickets: number;
      items: Record<string, unknown>[];
      totales: { efectivo: number; tarjeta: number; transferencia: number; credito: number };
    };

    expect(tickets).toBe(items.length);
    expect(totales).toEqual(
      expect.objectContaining({
        efectivo: expect.any(Number),
        tarjeta: expect.any(Number),
        transferencia: expect.any(Number),
        credito: expect.any(Number),
      }),
    );

    const primera = items[0];
    expect(primera?.['origenLegado']).toBe(true);
    expect(primera?.['turnoId']).toBe(turno?.turnoId);
    if (primera?.['fecha'] !== undefined) {
      expect(Number.isNaN(new Date(String(primera['fecha'])).getTime())).toBe(false);
    }
  });

  it('exige el turnoId', async () => {
    const r = await request(app).get(rutaVentas).set('Authorization', `Bearer ${tokenAdmin}`);
    expect(r.status).toBe(400);
  });

  it('el diagnostico dice de que proyecto viene y que turnos ve', async () => {
    const r = await request(app).get(rutaEstado).set('Authorization', `Bearer ${tokenAdmin}`);

    expect(r.status).toBe(200);
    expect(r.body.data.disponible).toBe(true);
    expect(r.body.data.error).toBeNull();
    expect(Array.isArray(r.body.data.turnosAbiertos)).toBe(true);
  });
});
