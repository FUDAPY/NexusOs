import type { NextFunction, Request, Response } from 'express';
import { obtenerResumenVentas } from '../services/reporte.service.js';
import { sendOk } from '../utils/response.js';


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
