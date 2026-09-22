import Fastify, { type FastifyInstance } from 'fastify';

type LoggerStream = { write: (message: string) => void };

export function buildServer(options: { logger: boolean; loggerStream?: LoggerStream }): FastifyInstance {
  const app = Fastify({
    logger: options.logger
      ? {
          serializers: {
            req: (request: { method: string; url: string }) => ({
              method: request.method,
              url: request.url.split('?', 1)[0]
            })
          },
          ...(options.loggerStream ? { stream: options.loggerStream } : {})
        }
      : false
  });

  app.get('/health', async () => ({
    service: 'mock-courier' as const,
    status: 'ok' as const
  }));

  return app;
}
