import { randomUUID } from 'node:crypto';
import { CourierWebhookError } from '../ports/courier-provider.js';

export type FaultMode = 'timeout' | 'http_500' | 'retryable_failure' | 'permanent_rejection' | 'delay' | 'duplicate';

export type FaultOptions = {
  readonly mode: FaultMode;
  readonly provider: string;
  readonly operation: string;
  readonly logger: { info(fields: Record<string, unknown>, message?: string): void };
  readonly delayMs?: number;
};

function canonicalOutcome(mode: FaultMode): string {
  return mode === 'http_500' ? 'retryable_failure' : mode;
}

function failedResult(mode: FaultMode, operation: string, input: Record<string, unknown> | undefined): unknown {
  if (!['timeout', 'http_500', 'retryable_failure', 'permanent_rejection'].includes(mode)) return undefined;

  const outcome = canonicalOutcome(mode);
  if (operation === 'verifyAndNormalize') {
    throw new CourierWebhookError(outcome as 'timeout' | 'retryable_failure' | 'permanent_rejection');
  }
  return {
    outcome,
    ...(typeof input?.notificationId === 'string' ? { notificationId: input.notificationId } : {})
  };
}

export function withFaultInjection<T extends object>(options: FaultOptions, provider: T): T {
  return new Proxy(provider, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        const input = args[0] as Record<string, unknown> | undefined;
        options.logger.info({
          event: 'provider_fault_injected',
          trace_id: typeof input?.traceId === 'string' ? input.traceId : randomUUID(),
          ...(typeof input?.orderId === 'string' ? { order_id: input.orderId } : {}),
          provider: options.provider,
          operation: options.operation,
          outcome: canonicalOutcome(options.mode),
          duration_ms: 0
        });
        if (options.mode === 'delay') await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 250));
        if (options.mode === 'duplicate') {
          const result: unknown = await Reflect.apply(value, target, args);
          return [result, result];
        }
        const injected = failedResult(options.mode, String(property), input);
        if (injected !== undefined) return injected;
        return Reflect.apply(value, target, args) as Promise<unknown>;
      };
    }
  });
}
