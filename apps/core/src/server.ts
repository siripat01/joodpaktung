import Fastify, { type FastifyInstance } from 'fastify';
import { withLogging } from './adapters/logging-decorator.js';
import { registerCourierWebhookRoute } from './http/courier-webhook-route.js';
import { HmacCourierProvider, type CourierProviderPort } from './ports/courier-provider.js';
import { registerCoreRoutes } from './http/routes.js';
import { loggerOptions } from './observability/logger.js';

type LoggerStream = { write: (message: string) => void };

export function buildServer(options: {
  logger: boolean;
  loggerStream?: LoggerStream;
  courierProvider?: CourierProviderPort;
}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ? loggerOptions(options.loggerStream) : false
  });

  app.get('/health', async () => ({
    service: 'payment-core' as const,
    status: 'ok' as const
  }));

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });
  const courierProvider = options.courierProvider ?? new HmacCourierProvider(
    process.env.COURIER_WEBHOOK_SECRET ?? 'local-courier-secret'
  );
  registerCourierWebhookRoute(app, withLogging({
    provider: 'courier',
    operation: 'verify_and_normalize',
    logger: app.log
  }, courierProvider));
  registerCoreRoutes(app);

  return app;
}
