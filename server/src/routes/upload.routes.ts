import { Router, type Request, type Response } from 'express';
import { requiereAuth } from '../middlewares/auth.js';
import { guardarImagen, obtenerImagen } from '../services/upload.service.js';
import { asyncHandler, sendOk } from '../utils/response.js';
import { env } from '../config/env.js';

export const uploadRouter = Router();

/**
 * POST /uploads  { carpeta?, nombre?, mime, datosBase64 }
 *
 * Sube una imagen y devuelve { id, url, mime, tamano }.
 *
 * Reemplaza a Firebase Storage, que ya no autoriza: subir el logo de una sucursal, la foto de
 * un producto o la de un ticket NUNCA funcionaba. La imagen viaja en base64 en el body porque
 * el proyecto no tiene parser de multipart, y agregar una dependencia para tres pantallas que
 * suben una imagen no se justifica.
 *
 * Exige token: sin esto cualquiera podria llenar la base de imagenes.
 */
uploadRouter.post(
  '/',
  requiereAuth,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as {
      carpeta?: unknown;
      nombre?: unknown;
      mime?: unknown;
      datosBase64?: unknown;
      /* Alias: la pantalla vieja mandaba `datos`. */
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

/**
 * GET /uploads/:id
 *
 * Sirve la imagen. SIN token a proposito: las pantallas la muestran con <img src>, que no
 * manda cabeceras de autorizacion. El id es un ObjectId, no adivinable, y ninguna imagen del
 * panel es un secreto. Es el mismo criterio que tenia la URL de descarga de Firebase.
 */
uploadRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const imagen = await obtenerImagen(String(req.params.id ?? ''));

    res.setHeader('Content-Type', imagen.mime);
    /* Un id siempre devuelve la misma imagen, asi que se puede cachear sin vencimiento: evita
       que cada apertura del listado vuelva a bajar todos los logos. */
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(imagen.datos);
  }),
);
