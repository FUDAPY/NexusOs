import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {
  coincideCodigo,
  normalizarCodigo,
  separarCodigos,
  validarCodigoAnulacion,
} from '../src/services/anulacionAutorizacion.service.js';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { redis } from '../src/config/redis.js';

/**
 * La autorizacion de anulaciones vive en settings/sistema y la valida el
 * servidor: el POS solo manda el codigo que leyo la tarjeta (o el que se cargo
 * a mano) y el backend decide. Aca se prueba esa decision y las rutas nuevas,
 * sin base de datos (el unico modelo que se toca es Setting).
 */
const estado = vi.hoisted(() => ({ setting: null as Record<string, unknown> | null }));

vi.mock('../src/models/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/models/index.js')>();
  return {
    ...real,
    Setting: {
      findOne: () => ({
        lean: () => ({
          exec: async () => estado.setting,
        }),
      }),
    },
  };
});

describe('separarCodigos', () => {
  it('deja la configuracion vacia sin codigos', () => {
    expect(separarCodigos('')).toEqual([]);
    expect(separarCodigos('   ')).toEqual([]);
    expect(separarCodigos(undefined)).toEqual([]);
    expect(separarCodigos(null)).toEqual([]);
    expect(separarCodigos(', ;; ,')).toEqual([]);
  });

  it('acepta un codigo unico y le saca los espacios de los bordes', () => {
    expect(separarCodigos('  ABC123  ')).toEqual(['ABC123']);
  });

  it('acepta varias tarjetas separadas por coma, punto y coma o salto de linea', () => {
    expect(separarCodigos('A1B2,c3d4;e5f6')).toEqual(['A1B2', 'c3d4', 'e5f6']);
    expect(separarCodigos('A1B2\nC3D4\r\nE5F6')).toEqual(['A1B2', 'C3D4', 'E5F6']);
  });

  it('no repite la misma tarjeta escrita distinto', () => {
    expect(separarCodigos('ABC, abc , AbC')).toEqual(['ABC']);
  });
});

describe('coincideCodigo', () => {
  it('acepta el mismo UID con espacios, dos puntos o guiones', () => {
    expect(coincideCodigo('E2 0A 3C 4B', ['e20a3c4b'])).toBe(true);
    expect(coincideCodigo('e2:0a:3c:4b', ['E20A3C4B'])).toBe(true);
    expect(coincideCodigo('abc-123', ['ABC123'])).toBe(true);
  });

  it('rechaza el codigo vacio, el erroneo y cuando no hay nada configurado', () => {
    expect(coincideCodigo('', ['ABC123'])).toBe(false);
    expect(coincideCodigo('   ', ['ABC123'])).toBe(false);
    expect(coincideCodigo(null, ['ABC123'])).toBe(false);
    expect(coincideCodigo('ZZZ999', ['ABC123'])).toBe(false);
    expect(coincideCodigo('ABC123', [])).toBe(false);
  });

  it('normaliza a solo letras y numeros en minusculas', () => {
    expect(normalizarCodigo(' E2-0A 3C.4B ')).toBe('e20a3c4b');
    expect(normalizarCodigo(null)).toBe('');
  });
});

describe('validarCodigoAnulacion', () => {
  beforeEach(() => {
    estado.setting = null;
  });

  it('sin tarjeta configurada permite anular un ticket (sucursal sin RFID)', async () => {
    await expect(validarCodigoAnulacion('')).resolves.toEqual({ requerido: false, verificado: false });
    await expect(validarCodigoAnulacion(undefined)).resolves.toEqual({
      requerido: false,
      verificado: false,
    });
  });

  it('sin tarjeta configurada rechaza el borrado masivo de mesas', async () => {
    await expect(validarCodigoAnulacion('loquesea', { obligatorio: true })).rejects.toMatchObject({
      statusCode: 428,
      code: 'CODIGO_ANULACION_NO_CONFIGURADO',
    });
  });

  it('con tarjeta configurada acepta el codigo aunque venga con otro formato', async () => {
    estado.setting = { legacyId: 'sistema', codigoRfidAnulacion: 'ABC123\nE2 0A 3C 4B' };

    await expect(validarCodigoAnulacion('abc123')).resolves.toEqual({
      requerido: true,
      verificado: true,
    });
    await expect(validarCodigoAnulacion(' e2-0a-3c-4b ')).resolves.toEqual({
      requerido: true,
      verificado: true,
    });
  });

  it('con tarjeta configurada rechaza el codigo ausente o erroneo', async () => {
    estado.setting = { legacyId: 'sistema', codigoRfidAnulacion: 'ABC123' };

    await expect(validarCodigoAnulacion('')).rejects.toMatchObject({
      statusCode: 403,
      code: 'CODIGO_ANULACION_INVALIDO',
    });
    await expect(validarCodigoAnulacion('otra-cosa')).rejects.toMatchObject({
      statusCode: 403,
      code: 'CODIGO_ANULACION_INVALIDO',
    });
  });

  it('lee el codigo aunque el documento de configuracion traiga otros campos', async () => {
    estado.setting = {
      legacyId: 'sistema',
      codigoRfidAnulacion: '  998877  ',
      creditoMaximoCliente: 50000,
    };

    await expect(validarCodigoAnulacion('998877')).resolves.toEqual({
      requerido: true,
      verificado: true,
    });
  });
});

const app = buildApp();

const tokenConRol = (rol: string): string =>
  jwt.sign(
    { sub: 'uid-anulacion', rol, sucursal: 'Centro', nombre: 'Cajera Test' },
    env.JWT_SECRET,
    { expiresIn: '5m' },
  );

describe('rutas de anulacion (/orders)', () => {
  const rutaEstado = `${env.API_PREFIX}/orders/anulacion/estado`;
  const rutaVerificar = `${env.API_PREFIX}/orders/anulacion/verificar-codigo`;
  const rutaMesas = `${env.API_PREFIX}/orders/mesas-abiertas/anular`;

  beforeAll(() => {
    // Sin base: que Mongo falle rapido si alguna ruta llega a consultarlo.
    mongoose.set('bufferTimeoutMS', 300);
  });

  afterAll(() => {
    redis.disconnect();
  });

  beforeEach(() => {
    estado.setting = null;
  });

  it('sin token las tres rutas siguen cerradas', async () => {
    expect((await request(app).get(rutaEstado)).status).toBe(401);
    expect((await request(app).post(rutaVerificar).send({ codigo: 'ABC' })).status).toBe(401);
    expect((await request(app).post(rutaMesas).send({ codigo: 'ABC' })).status).toBe(401);
  });

  it('el estado solo dice si hay tarjeta: nunca devuelve el codigo', async () => {
    estado.setting = { legacyId: 'sistema', codigoRfidAnulacion: 'ABC123\nE2 0A 3C 4B' };

    const res = await request(app)
      .get(rutaEstado)
      .set('Authorization', `Bearer ${tokenConRol('cajero')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { requerido: true, tarjetas: 2 } });
    expect(JSON.stringify(res.body)).not.toContain('ABC123');
    expect(JSON.stringify(res.body)).not.toContain('e20a3c4b');
  });

  it('verificar el codigo responde 200 sin anular nada y 403 si no coincide', async () => {
    estado.setting = { legacyId: 'sistema', codigoRfidAnulacion: 'ABC123' };

    const ok = await request(app)
      .post(rutaVerificar)
      .set('Authorization', `Bearer ${tokenConRol('cajero')}`)
      .send({ codigo: 'abc-123' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ requerido: true, verificado: true });

    const malo = await request(app)
      .post(rutaVerificar)
      .set('Authorization', `Bearer ${tokenConRol('cajero')}`)
      .send({ codigo: 'otra-cosa' });
    expect(malo.status).toBe(403);
    expect(malo.body.code).toBe('CODIGO_ANULACION_INVALIDO');
  });

  it('borrar mesas abiertas no lo captura /:id/anular (sin tarjeta configurada da 428)', async () => {
    /* Si Express tomara 'mesas-abiertas' como el :id de /:id/anular, esta
       peticion terminaria en un error de orden inexistente en vez del 428 de
       "no hay tarjeta configurada". */
    const res = await request(app)
      .post(rutaMesas)
      .set('Authorization', `Bearer ${tokenConRol('cajero')}`)
      .send({ codigo: 'ABC123', sucursal: 'Centro', motivo: 'limpieza de mesas viejas' });

    expect(res.status).toBe(428);
    expect(res.body.code).toBe('CODIGO_ANULACION_NO_CONFIGURADO');
  });

  it('borrar mesas con codigo erroneo responde 403 y no toca ninguna orden', async () => {
    estado.setting = { legacyId: 'sistema', codigoRfidAnulacion: 'ABC123' };

    const res = await request(app)
      .post(rutaMesas)
      .set('Authorization', `Bearer ${tokenConRol('cajero')}`)
      .send({ codigo: 'otra-cosa', sucursal: 'Centro' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CODIGO_ANULACION_INVALIDO');
  });

  it('un rol sin permiso no autoriza anulaciones', async () => {
    const res = await request(app)
      .post(rutaVerificar)
      .set('Authorization', `Bearer ${tokenConRol('cliente')}`)
      .send({ codigo: 'ABC123' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SIN_PERMISO');
  });
});
