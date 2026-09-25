import Fastify, { type FastifyInstance } from 'fastify';
import { withLogging } from './adapters/logging-decorator.js';
import { registerCourierWebhookRoute } from './http/courier-webhook-route.js';
import { registerRoutes } from './http/routes.js';
import { registerSseRoute, type CommittedEvent } from './http/sse.js';
import type { PaymentCommand, CommandContext, CommandResult } from './application/commands.js';
import { handleCommand } from './application/command-handler.js';
import { HmacCourierProvider, type CourierProviderPort } from './ports/courier-provider.js';

type LoggerStream = { write: (message: string) => void };

export function buildServer(options: {
  logger: boolean;
  loggerStream?: LoggerStream;
  courierProvider?: CourierProviderPort;
  executeCommand?: (command: PaymentCommand, context: CommandContext) => Promise<CommandResult>;
  readEvents?: (cursor: number) => Promise<CommittedEvent[]>;
}): FastifyInstance {
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
  registerRoutes(app, options.executeCommand ?? handleCommand);
  registerSseRoute(app, options.readEvents);

  return app;
}
