import pino from 'pino';
import { config } from '../config.js';

export const logger = pino({
  level: config.NODE_ENV === 'production' ? 'info' : 'debug',
  base: { instance: config.INSTANCE_ID },
  redact: {
    paths: ['req.headers.cookie', 'req.headers.authorization', 'password', '*.password', 'code', 'state'],
    censor: '[redacted]',
  },
});
