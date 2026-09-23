import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withFaultInjection } from '../../src/adapters/fault-decorator.js';
import { withLogging } from '../../src/adapters/logging-decorator.js';
import { LocalChatNotificationProvider } from '../../src/adapters/local-chat.js';
import { LocalPaymentProvider } from '../../src/adapters/local-payment.js';
import { CourierWebhookError, HmacCourierProvider } from '../../src/ports/courier-provider.js';

const secret = 'courier-hmac-test-secret';

function signedEvent(payload: Record<string, unknown>): { rawBody: Buffer; signature: string } {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  return { rawBody, signature };
}

describe('provider contracts', () => {
  it('normalizes signed pickup, delivery, and late charge update events', async () => {
    const courier = new HmacCourierProvider(secret);

    await expect(courier.verifyAndNormalize(signedEvent({
      id: 'pickup-1', kind: 'picked_up', shipmentToken: 'shipment-1', chargedFee: 3000
    }))).resolves.toEqual({
      kind: 'picked_up', eventKey: 'pickup-1', shipmentToken: 'shipment-1', chargedFee: 3000
    });
    await expect(courier.verifyAndNormalize(signedEvent({
      id: 'delivered-1', kind: 'delivered', shipmentToken: 'shipment-1'
    }))).resolves.toEqual({
      kind: 'delivered', eventKey: 'delivered-1', shipmentToken: 'shipment-1'
    });
    await expect(courier.verifyAndNormalize(signedEvent({
      id: 'reweigh-1', kind: 'charge_updated', shipmentToken: 'shipment-1', chargedFee: 5000, finalized: true
    }))).resolves.toEqual({
      kind: 'courier_charge_updated', eventKey: 'reweigh-1', shipmentToken: 'shipment-1', chargedFee: 5000, finalized: true
    });
  });

  it('rejects invalid signatures and malformed signed evidence', async () => {
    const courier = new HmacCourierProvider(secret);
    const invalid = signedEvent({ id: 'pickup-1', kind: 'picked_up', shipmentToken: 'shipment-1', chargedFee: 3000 });

    await expect(courier.verifyAndNormalize({ ...invalid, signature: '00'.repeat(32) })).rejects.toMatchObject({
      code: 'invalid_signature'
    });
    await expect(courier.verifyAndNormalize(signedEvent({
      id: 'pickup-2', kind: 'picked_up', shipmentToken: 'shipment-1', chargedFee: -1
    }))).rejects.toMatchObject({ code: 'invalid_payload' });
  });

  it('logs provider metadata with correlation and latency while excluding sensitive values', async () => {
    const records: Record<string, unknown>[] = [];
    const provider = withLogging({
      provider: 'courier',
      operation: 'verify_webhook',
      logger: { info: (fields) => records.push(fields) }
    }, new HmacCourierProvider(secret));
    const input = { ...signedEvent({ id: 'pickup-safe-id', kind: 'picked_up', shipmentToken: 'private-token', chargedFee: 3000 }), traceId: 'trace-courier-1' };

    await provider.verifyAndNormalize(input);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ trace_id: 'trace-courier-1', provider: 'courier', operation: 'verify_webhook', outcome: 'success' });
    expect(JSON.stringify(records)).not.toContain(secret);
    expect(JSON.stringify(records)).not.toContain(input.signature);
    expect(JSON.stringify(records)).not.toContain('private-token');
  });

  it('returns canonical timeout and retryable outcomes for payment faults without calling the provider', async () => {
    let called = false;
    const records: Record<string, unknown>[] = [];
    const payment = {
      submit: async (_input: { traceId: string; orderId: string; idempotencyKey: string; action: 'reserve'; amountSatang: string }) => { called = true; return { outcome: 'success' as const, providerReference: 'local-1' }; }
    };
    const input = { traceId: 'trace-1', orderId: 'order-1', idempotencyKey: 'payment-1', action: 'reserve' as const, amountSatang: '133500' };
    const timeoutProvider = withFaultInjection({ mode: 'timeout', provider: 'payment', operation: 'submit', logger: { info: (fields) => records.push(fields) } }, payment);
    const failedServerProvider = withFaultInjection({ mode: 'http_500', provider: 'payment', operation: 'submit', logger: { info: (fields) => records.push(fields) } }, payment);

    await expect(timeoutProvider.submit(input)).resolves.toEqual({ outcome: 'timeout' });
    await expect(failedServerProvider.submit(input)).resolves.toEqual({ outcome: 'retryable_failure' });
    expect(called).toBe(false);
    expect(records[0]).toMatchObject({ event: 'provider_fault_injected', trace_id: 'trace-1', provider: 'payment', operation: 'submit', outcome: 'timeout' });
    expect(records[1]).toMatchObject({ outcome: 'retryable_failure' });
  });

  it('returns notification faults with the required notification identifier', async () => {
    const notification = { traceId: 'trace-chat', orderId: 'order-1', notificationId: 'notification-1', recipient: 'seller' as const, message: 'Order accepted' };
    const provider = { send: async (input: { notificationId: string }) => ({ outcome: 'success' as const, notificationId: input.notificationId }) };
    const logger = { info: (_fields: Record<string, unknown>) => undefined };

    await expect(withFaultInjection({ mode: 'timeout', provider: 'chat', operation: 'send', logger }, provider).send(notification))
      .resolves.toEqual({ outcome: 'timeout', notificationId: 'notification-1' });
    await expect(withFaultInjection({ mode: 'http_500', provider: 'chat', operation: 'send', logger }, provider).send(notification))
      .resolves.toEqual({ outcome: 'retryable_failure', notificationId: 'notification-1' });
  });

  it('maps courier timeout and HTTP 500 to typed canonical verification failures', async () => {
    const input = signedEvent({ id: 'pickup-fault', kind: 'picked_up', shipmentToken: 'shipment-1', chargedFee: 3000 });
    const logger = { info: (_fields: Record<string, unknown>) => undefined };

    await expect(withFaultInjection({ mode: 'timeout', provider: 'courier', operation: 'verify', logger }, new HmacCourierProvider(secret)).verifyAndNormalize(input))
      .rejects.toMatchObject({ constructor: CourierWebhookError, code: 'timeout' });
    await expect(withFaultInjection({ mode: 'http_500', provider: 'courier', operation: 'verify', logger }, new HmacCourierProvider(secret)).verifyAndNormalize(input))
      .rejects.toMatchObject({ constructor: CourierWebhookError, code: 'retryable_failure' });
  });
  it('returns the same payment result for a repeated idempotency key', async () => {
    const provider = new LocalPaymentProvider();
    const instruction = { traceId: 'trace-payment', orderId: 'order-1', idempotencyKey: 'payment-1', action: 'reserve' as const, amountSatang: '133500' };
    const [first, replay] = await Promise.all([provider.submit(instruction), provider.submit(instruction)]);

    expect(first).toEqual({ outcome: 'success', providerReference: 'local-payment:payment-1' });
    expect(replay).toEqual(first);
  });

  it('deduplicates chat delivery by notification ID and supports failure before acknowledgement', async () => {
    const provider = new LocalChatNotificationProvider();
    const notification = { traceId: 'trace-chat', orderId: 'order-1', notificationId: 'notification-1', recipient: 'seller' as const, message: 'Order accepted' };
    const first = await provider.send(notification);
    const replay = await provider.send(notification);

    expect(first).toEqual({ outcome: 'success', notificationId: 'notification-1' });
    expect(replay).toEqual(first);
    expect(provider.deliveries()).toEqual([notification]);

    const failingProvider = new LocalChatNotificationProvider({ failBeforeAcknowledgement: true });
    expect(await failingProvider.send(notification)).toEqual({ outcome: 'retryable_failure', notificationId: 'notification-1' });
    expect(failingProvider.deliveries()).toEqual([]);
  });
});
