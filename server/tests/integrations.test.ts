import { describe, expect, it } from 'vitest';
import type { NextFunction, Request } from 'express';
import { requireServiceToken } from '../src/middlewares/auth.js';

/* El token de servicio habilita escrituras de stock desde fuera. Solo se
   prueba el middleware: comprobarlo aqui evita depender de una base de datos
   para validar la parte que decide si una peticion entra o no. */

const TOKEN_VALIDO = 'a'.repeat(64);

const peticion = (headers: Record<string, string>): Request =>
  ({ header: (nombre: string) => headers[nombre.toLowerCase()] ?? null }) as unknown as Request;

const ejecutar = (req: Request): { paso: boolean; codigo?: string } => {
  let paso = false;
  let codigo: string | undefined;

  requireServiceToken(req, {}, ((error?: unknown) => {
    paso = error === undefined;
    const e = error as { code?: string } | undefined;
    codigo = e?.code;
  }) as NextFunction);

  return { paso, codigo };
};

describe('token de servicio', () => {
  it('acepta el token correcto', async () => {
    const { env } = await import('../src/config/env.js');
    env.INTEGRATION_TOKEN = TOKEN_VALIDO;
    expect(ejecutar(peticion({ 'x-service-token': TOKEN_VALIDO })).paso).toBe(true);
  });

  it('rechaza un token distinto', async () => {
    const { env } = await import('../src/config/env.js');
    env.INTEGRATION_TOKEN = TOKEN_VALIDO;
    const r = ejecutar(peticion({ 'x-service-token': 'b'.repeat(64) }));
    expect(r.paso).toBe(false);
    expect(r.codigo).toBe('UNAUTHORIZED');
  });

  it('rechaza cuando no viene el header', async () => {
    const { env } = await import('../src/config/env.js');
    env.INTEGRATION_TOKEN = TOKEN_VALIDO;
    expect(ejecutar(peticion({})).paso).toBe(false);
  });

  it('rechaza un token de longitud distinta sin romper', async () => {
    const { env } = await import('../src/config/env.js');
    env.INTEGRATION_TOKEN = TOKEN_VALIDO;
    const r = ejecutar(peticion({ 'x-service-token': 'corto' }));
    expect(r.paso).toBe(false);
    expect(r.codigo).toBe('UNAUTHORIZED');
  });

  it('rechaza todo si el servidor no tiene token configurado', async () => {
    const { env } = await import('../src/config/env.js');
    env.INTEGRATION_TOKEN = undefined;
    expect(ejecutar(peticion({ 'x-service-token': TOKEN_VALIDO })).paso).toBe(false);
  });

  it('no acepta el JWT_SECRET como token de integracion', async () => {
    /* Se separaron a proposito: si el secreto de firma se filtra, el alcance
       del dano no debe ampliarse hasta poder firmar sesiones de administrador. */
    const { env } = await import('../src/config/env.js');
    env.INTEGRATION_TOKEN = TOKEN_VALIDO;
    const r = ejecutar(peticion({ 'x-service-token': env.JWT_SECRET }));
    expect(r.paso).toBe(false);
  });
});