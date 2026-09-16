import pino from 'pino';
import { env } from '../config/env.js';

/**
 * En test el logger se silencia.
 *
 * Con `debug` (el default de todo lo que no sea produccion), pino-http loguea
 * cada request con sus headers: cientos de lineas JSON entre el resultado de los
 * tests. Peor que el ruido es el riesgo de que un error real quede enterrado.
 *
 * Si un test puntual necesita ver los logs, alcanza con subir el nivel:
 *   logger.level = 'debug'
 */
const nivel = env.NODE_ENV === 'test' ? 'silent' : env.NODE_ENV === 'production' ? 'info' : 'debug';

export const logger = pino({
  level: nivel,
  base: { service: 'pos-cate-server', env: env.NODE_ENV },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.pin',
      '*.rfid',
      '*.password',
      '*.passwordHash',
    ],
    censor: '[REDACTED]',
  },
});
