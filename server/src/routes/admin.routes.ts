import { Router } from 'express';
import { requiereRol } from '../middlewares/auth.js';
import { AppError, asyncHandler, sendOk } from '../utils/response.js';
import { logger } from '../utils/logger.js';
import {
  migrarFirestore,
  type MigracionEvento,
  type MigracionResumen,
} from '../services/migracionFirestore.service.js';

/**
 * Tareas de administracion que no son CRUD.
 *
 * POR QUE ESTA LA MIGRACION ACA Y NO SOLO EN UN SCRIPT: la base de produccion no esta
 * publicada a internet, asi que el ETL no se puede correr desde una maquina de desarrollo.
 * El contenedor del API si tiene acceso a Mongo y a Firestore, y es el unico lugar donde la
 * migracion puede correr.
 */
interface EstadoMigracion {
  enCurso: boolean;
  iniciadoEn: string | null;
  terminadoEn: string | null;
  eventos: MigracionEvento[];
  resumen: MigracionResumen | null;
  error: string | null;
}

const estado: EstadoMigracion = {
  enCurso: false,
  iniciadoEn: null,
  terminadoEn: null,
  eventos: [],
  resumen: null,
  error: null,
};

export const adminRouter: Router = Router();

/* Todo lo de este router es de admin: la migracion escribe en la base entera. */
adminRouter.use(requiereRol('admin'));

/**
 * POST /admin/migrar-firestore  { aplicar?: boolean }
 *
 * Lanza la migracion COMPLETA de Firestore a Mongo (idempotente: upsert por `_id`/`legacyId`).
 * Responde 202 enseguida y sigue en segundo plano: son 24 colecciones y puede tardar minutos.
 * Sin `aplicar: true` es simulacion: lee Firestore y no escribe nada.
 *
 * El progreso se mira con GET /admin/migrar-firestore.
 */
adminRouter.post(
  '/migrar-firestore',
  asyncHandler(async (req, res) => {
    if (estado.enCurso) {
      throw new AppError('Ya hay una migracion en curso', 409, 'MIGRACION_EN_CURSO');
    }

    const aplicar = (req.body as { aplicar?: unknown } | undefined)?.aplicar === true;
    estado.enCurso = true;
    estado.iniciadoEn = new Date().toISOString();
    estado.terminadoEn = null;
    estado.eventos = [];
    estado.resumen = null;
    estado.error = null;

    void migrarFirestore({
      aplicar,
      alProgreso: (evento) => {
        estado.eventos.push(evento);
      },
    })
      .then((resumen) => {
        estado.resumen = resumen;
      })
      .catch((error: unknown) => {
        estado.error = error instanceof Error ? error.message : String(error);
        logger.error({ err: error }, 'Migracion Firestore -> MongoDB fallida');
      })
      .finally(() => {
        estado.enCurso = false;
        estado.terminadoEn = new Date().toISOString();
      });

    sendOk(res, { iniciado: true, aplicar, iniciadoEn: estado.iniciadoEn }, 202);
  }),
);

/** GET /admin/migrar-firestore -> estado y resultado de la ultima corrida. */
adminRouter.get(
  '/migrar-firestore',
  asyncHandler(async (_req, res) => {
    sendOk(res, estado);
  }),
);
