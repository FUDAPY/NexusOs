import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/response.js';


interface OpcionesLimite {
  
  maximo: number;
  
  ventanaMs: number;
  
  mensaje: string;
}

const VENTANA_LIMPIEZA_MS = 60_000;


const intentos = new Map<string, number[]>();


const ventanaMasLarga = { valor: 0 };


const podar = (): void => {
  const corte = Date.now() - ventanaMasLarga.valor;
  for (const [clave, marcas] of intentos) {
    const vivas = marcas.filter((marca) => marca > corte);
    if (vivas.length === 0) intentos.delete(clave);
    else intentos.set(clave, vivas);
  }
};


setInterval(podar, VENTANA_LIMPIEZA_MS).unref();


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
