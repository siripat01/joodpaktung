import Fastify, { type FastifyInstance } from 'fastify';

export function buildServer(options: { logger: boolean }): FastifyInstance {
  const app = Fastify({ logger: options.logger });

  app.get('/health', async () => ({
    service: 'payment-core' as const,
    status: 'ok' as const
  }));

  return app;
}
