import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
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
