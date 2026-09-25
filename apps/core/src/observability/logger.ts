import type { FastifyServerOptions } from 'fastify';

type LoggerStream = { write(message: string): void };

/** Logging configuration shared by every HTTP boundary. Sensitive headers are
 * removed at serialization time; bodies are deliberately never serialized. */
export function loggerOptions(stream?: LoggerStream): FastifyServerOptions['logger'] {
  return {
    base: { service: 'payment-core' },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.x-courier-signature',
        'authorization',
        'signature',
        'pin',
        'secret',
        'token'
      ],
      censor: '[REDACTED]'
    },
    serializers: {
      req: (request: { method: string; url: string }) => ({
        method: request.method,
        url: request.url.split('?', 1)[0]
      })
    },
    ...(stream ? { stream } : {})
  };
}
