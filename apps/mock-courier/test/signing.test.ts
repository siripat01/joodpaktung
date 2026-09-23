import { describe, expect, it } from 'vitest';
import { signWebhook, verifyWebhookSignature } from '../src/signing.js';
import { courierScenarios, createScenarioDeliveries } from '../src/scenarios.js';

describe('Mock Courier signing and deterministic scenarios', () => {
  it('signs exact payload bytes and rejects a changed signature', () => {
    const body = Buffer.from('{"id":"pickup-1","kind":"picked_up"}');
    const signature = signWebhook(body, 'mock-courier-secret');

    expect(verifyWebhookSignature(body, signature, 'mock-courier-secret')).toBe(true);
    expect(verifyWebhookSignature(body, `${signature.slice(0, -1)}0`, 'mock-courier-secret')).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(`${body.toString()} `), signature, 'mock-courier-secret')).toBe(false);
  });

  it('exposes deterministic duplicate, reorder, delay, timeout, and server-error scenarios', () => {
    expect(courierScenarios.duplicate.events?.map((event) => event.id)).toEqual(['pickup-duplicate', 'pickup-duplicate']);
    expect(courierScenarios.deliveredBeforePickup.events?.map((event) => event.id)).toEqual(['delivered-early', 'pickup-after-delivery']);
    expect(courierScenarios.delayed.delayMs).toBe(250);
    expect(courierScenarios.timeout.failure).toBe('timeout');
    expect(courierScenarios.serverError.failure).toBe('http_500');
    expect(courierScenarios.invalidSignature.signatureValid).toBe(false);
    expect(courierScenarios.validPickup.signatureValid).toBe(true);
  });
  it('builds signed, duplicate, reordered, delayed, and failed scenario deliveries', () => {
    const valid = createScenarioDeliveries('validPickup', 'mock-courier-secret');
    expect(valid.deliveries).toHaveLength(1);
    expect(verifyWebhookSignature(valid.deliveries[0]!.rawBody, valid.deliveries[0]!.signature, 'mock-courier-secret')).toBe(true);

    const invalid = createScenarioDeliveries('invalidSignature', 'mock-courier-secret');
    expect(verifyWebhookSignature(invalid.deliveries[0]!.rawBody, invalid.deliveries[0]!.signature, 'mock-courier-secret')).toBe(false);
    const duplicate = createScenarioDeliveries('duplicate', 'mock-courier-secret');
    expect(duplicate.deliveries.map((delivery) => JSON.parse(delivery.rawBody.toString()).id)).toEqual(['pickup-duplicate', 'pickup-duplicate']);
    expect(createScenarioDeliveries('delayed', 'mock-courier-secret').delayMs).toBe(250);
    expect(createScenarioDeliveries('timeout', 'mock-courier-secret').failure).toBe('timeout');
    expect(createScenarioDeliveries('serverError', 'mock-courier-secret').failure).toBe('http_500');
  });
});
