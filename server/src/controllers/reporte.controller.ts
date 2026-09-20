import type { NextFunction, Request, Response } from 'express';
import { obtenerResumenVentas } from '../services/reporte.service.js';
import { sendOk } from '../utils/response.js';

/**
 * GET /api/v1/orders/resumen?desde&hasta[&sucursal]
 *
 * Totales y desgloses de ventas calculados en Mongo, en una sola consulta.
 *
 * Reemplaza al patron viejo de bajar hasta 1000 ordenes al navegador y sumarlas ahi: con un
 * historico largo eran megabytes de JSON y un recorrido completo en JS para dibujar un
 * resumen. Aca la respuesta son unas pocas decenas de filas.
 */
export const resumenVentas = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const q = req.query as { desde?: unknown; hasta?: unknown; sucursal?: unknown };

    sendOk(
      res,
      await obtenerResumenVentas({
        desde: typeof q.desde === 'string' ? q.desde : undefined,
        hasta: typeof q.hasta === 'string' ? q.hasta : undefined,
        sucursal: typeof q.sucursal === 'string' ? q.sucursal : undefined,
      }),
    );
  } catch (error) {
    next(error);
  }
};
