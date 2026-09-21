import { Router, type Request, type Response } from 'express';
import { requiereAuth } from '../middlewares/auth.js';
import { guardarImagen, obtenerImagen } from '../services/upload.service.js';
import { asyncHandler, sendOk } from '../utils/response.js';
import { env } from '../config/env.js';

export const uploadRouter = Router();


uploadRouter.post(
  '/',
  requiereAuth,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as {
      carpeta?: unknown;
      nombre?: unknown;
      mime?: unknown;
      datosBase64?: unknown;
      
      datos?: unknown;
      subidoPor?: unknown;
    };

    sendOk(
      res,
      await guardarImagen(
        {
          carpeta: typeof body.carpeta === 'string' ? body.carpeta : undefined,
          nombre: typeof body.nombre === 'string' ? body.nombre : undefined,
          mime: typeof body.mime === 'string' ? body.mime : undefined,
          datosBase64:
            typeof body.datosBase64 === 'string'
              ? body.datosBase64
              : typeof body.datos === 'string'
                ? body.datos
                : undefined,
          subidoPor: typeof body.subidoPor === 'string' ? body.subidoPor : undefined,
        },
        env.API_PREFIX,
      ),
      201,
    );
  }),
);


uploadRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const imagen = await obtenerImagen(String(req.params.id ?? ''));

    res.setHeader('Content-Type', imagen.mime);
    
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(imagen.datos);
  }),
);
