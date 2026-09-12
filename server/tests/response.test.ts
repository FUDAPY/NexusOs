import { describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import { AppError, fail, ok, sendFail, sendOk } from '../src/utils/response.js';

const createRes = (): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { res: { status } as unknown as Response, status, json };
};

describe('contrato de respuesta', () => {
  it('ok envuelve datos con success true', () => {
    expect(ok({ id: 1 })).toEqual({ success: true, data: { id: 1 } });
  });

  it('fail devuelve el formato de error estandar', () => {
    expect(fail('sin stock')).toEqual({ success: false, error: 'sin stock' });
    expect(fail('sin stock', 'INSUFFICIENT_STOCK')).toEqual({
      success: false,
      error: 'sin stock',
      code: 'INSUFFICIENT_STOCK',
    });
  });

  it('sendOk responde con el status indicado', () => {
    const { res, status, json } = createRes();
    sendOk(res, { total: 10 }, 201);
    expect(status).toHaveBeenCalledWith(201);
    expect(json).toHaveBeenCalledWith({ success: true, data: { total: 10 } });
  });

  it('sendFail responde con el formato de error estandar', () => {
    const { res, status, json } = createRes();
    sendFail(res, 409, 'conflicto', 'CONFLICT');
    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({ success: false, error: 'conflicto', code: 'CONFLICT' });
  });
});

describe('AppError', () => {
  it('conserva statusCode y code', () => {
    const error = new AppError('no encontrado', 404, 'NOT_FOUND');
    expect(error).toBeInstanceOf(Error);
    expect(error.statusCode).toBe(404);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('no encontrado');
  });
});
