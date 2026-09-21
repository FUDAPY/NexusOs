import { Router } from 'express';
import { requiereRol } from '../middlewares/auth.js';
import { asyncHandler, sendOk } from '../utils/response.js';
import {
  estadoLegado,
  leerVentasTurnoLegado,
  listarTurnosAbiertosLegado,
} from '../services/legado.service.js';

/**
 * Puente de SOLO LECTURA al sistema viejo (Firestore).
 *
 * POR QUE EXISTE
 * Los cajeros siguen vendiendo en el POS viejo mientras se construye este, asi que sus
 * ventas no estan en Mongo. El dashboard lee Mongo; estos endpoints son la unica via
 * para que vea el turno abierto real, sin darle credenciales de Firebase al navegador.
 *
 * CONTRATO
 * Devuelve las filas con la MISMA forma que `/orders` (los documentos de `sales`
 * conservan los nombres de campo del sistema viejo) para que el panel las procese con
 * el mismo codigo. Los montos vienen calculados con la formula del arqueo, no con una
 * copia en el navegador.
 *
 * SI NO ESTA CONFIGURADO responde 503 `LEGADO_NO_CONFIGURADO`: el panel tiene que poder
 * seguir funcionando (solo que sin datos del sistema viejo) cuando la credencial no
 * esta puesta todavia.
 */
export const legadoRouter: Router = Router();

/** Turnos abiertos AHORA en el sistema viejo: uno por sucursal (el activo). */
legadoRouter.get(
  '/turnos-abiertos',
  asyncHandler(async (_req, res) => {
    sendOk(res, { turnos: await listarTurnosAbiertosLegado() });
  }),
);

/** Tickets de un turno + totales y productos calculados con los helpers del arqueo. */
legadoRouter.get(
  '/ventas',
  asyncHandler(async (req, res) => {
    const turnoId = typeof req.query['turnoId'] === 'string' ? req.query['turnoId'] : '';
    const resumen = await leerVentasTurnoLegado(turnoId);
    sendOk(res, {
      turnoId: resumen.turnoId,
      tickets: resumen.tickets,
      items: resumen.items,
      totales: resumen.totales,
      productos: resumen.productos,
    });
  }),
);

/**
 * Diagnostico: que ve el servidor del sistema viejo.
 * Solo admin: expone el proyecto y la ruta de las ventas del sistema viejo.
 */
legadoRouter.get(
  '/estado',
  requiereRol('admin'),
  asyncHandler(async (_req, res) => {
    sendOk(res, await estadoLegado());
  }),
);
