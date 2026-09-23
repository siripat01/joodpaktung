import { randomUUID } from 'node:crypto';

type BoundaryLogger = { info(fields: Record<string, unknown>, message?: string): void };

export type LoggingOptions = {
  readonly provider: string;
  readonly operation: string;
  readonly logger: BoundaryLogger;
};

function safeFields(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {};
  const input = value as Record<string, unknown>;
  return {
    ...(typeof input.traceId === 'string' ? { trace_id: input.traceId } : {}),
    ...(typeof input.orderId === 'string' ? { order_id: input.orderId } : {}),
    ...(typeof input.notificationId === 'string' ? { notification_id: input.notificationId } : {}),
    ...(typeof input.idempotencyKey === 'string' ? { idempotency_key: input.idempotencyKey } : {})
  };
}

export function withLogging<T extends object>(options: LoggingOptions, provider: T): T {
  return new Proxy(provider, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        const startedAt = Date.now();
        const fields = safeFields(args[0]);
        const base = {
          event: 'provider_operation',
          trace_id: fields.trace_id ?? randomUUID(),
          provider: options.provider,
          operation: options.operation || String(property),
          ...fields
        };
        try {
          const result: unknown = await Reflect.apply(value, target, args);
          options.logger.info({ ...base, outcome: 'success', duration_ms: Date.now() - startedAt });
          return result;
        } catch (error) {
          options.logger.info({
            ...base,
            outcome: 'failure',
            duration_ms: Date.now() - startedAt,
            error_type: error instanceof Error ? error.name : 'unknown'
          });
          throw error;
        }
      };
    }
  });
}
