import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/response.js';

/**
 * Limitador de intentos en memoria (ventana deslizante por IP).
 *
 * Por que en memoria y no en Redis: si Redis se cae, un limitador que dependa de
 * el tumbaria el login entero. Preferimos que en ese caso el login siga
 * funcionando sin limite antes que dejar a los cajeros afuera.
 *
 * Limitacion conocida: con varias replicas del servicio cada una lleva su propio
 * conteo, asi que el limite efectivo es (maximo x replicas). Para un POS de
 * local no es un problema; si algun dia se escala horizontal, hay que moverlo a
 * Redis.
 */
interface OpcionesLimite {
  /** Intentos permitidos dentro de la ventana. */
  maximo: number;
  /** Tamano de la ventana en milisegundos. */
  ventanaMs: number;
  /** Texto del error cuando se supera. */
  mensaje: string;
}

const VENTANA_LIMPIEZA_MS = 60_000;

/** ip -> marcas de tiempo (ms) de sus intentos recientes. */
const intentos = new Map<string, number[]>();

/** Cuanto dura la ventana mas larga registrada, para saber que se puede tirar. */
const ventanaMasLarga = { valor: 0 };

/**
 * Podado periodico. Sin esto el Map crece para siempre: cada IP nueva que pega
 * una vez deja una entrada que nadie vuelve a tocar.
 */
const podar = (): void => {
  const corte = Date.now() - ventanaMasLarga.valor;
  for (const [clave, marcas] of intentos) {
    const vivas = marcas.filter((marca) => marca > corte);
    if (vivas.length === 0) intentos.delete(clave);
    else intentos.set(clave, vivas);
  }
};

// unref(): este temporizador no debe mantener vivo el proceso al apagarse.
setInterval(podar, VENTANA_LIMPIEZA_MS).unref();

/**
 * Middleware que corta con 429 cuando una misma IP supera `maximo` intentos
 * dentro de `ventanaMs`. Pensado para /auth/login, donde sin limite una sola
 * IP puede probar contraseñas indefinidamente.
 */
export const limitarIntentos =
  (opciones: OpcionesLimite) =>
  (req: Request, res: Response, next: NextFunction): void => {
    if (opciones.ventanaMs > ventanaMasLarga.valor) ventanaMasLarga.valor = opciones.ventanaMs;

    const clave = req.ip ?? req.socket.remoteAddress ?? 'sin-ip';
    const ahora = Date.now();
    const desde = ahora - opciones.ventanaMs;

    const previos = (intentos.get(clave) ?? []).filter((marca) => marca > desde);

    if (previos.length >= opciones.maximo) {
      const masViejo = previos[0];
      const esperaMs = masViejo === undefined ? opciones.ventanaMs : masViejo + opciones.ventanaMs - ahora;
      const esperaSeg = Math.max(1, Math.ceil(esperaMs / 1000));

      res.setHeader('Retry-After', String(esperaSeg));
      next(new AppError(`${opciones.mensaje} Reintentar en ${esperaSeg}s.`, 429, 'DEMASIADOS_INTENTOS'));
      return;
    }

    previos.push(ahora);
    intentos.set(clave, previos);
    next();
  };
