import { invalidWebhookSignature, signWebhook } from './signing.js';

export type CourierScenarioPayload = {
  readonly id: string;
  readonly kind: 'picked_up' | 'delivered' | 'charge_updated';
  readonly shipmentToken: string;
  readonly chargedFee?: number;
  readonly finalized?: boolean;
};

export type CourierScenario = {
  readonly signatureValid: boolean;
  readonly events?: readonly CourierScenarioPayload[];
  readonly delayMs?: number;
  readonly failure?: 'timeout' | 'http_500';
};

export const courierScenarios = {
  validPickup: {
    signatureValid: true,
    events: [{ id: 'pickup-1', kind: 'picked_up', shipmentToken: 'seed-shipment-token', chargedFee: 3000 }]
  },
  invalidSignature: {
    signatureValid: false,
    events: [{ id: 'pickup-invalid-signature', kind: 'picked_up', shipmentToken: 'seed-shipment-token', chargedFee: 3000 }]
  },
  duplicate: {
    signatureValid: true,
    events: [
      { id: 'pickup-duplicate', kind: 'picked_up', shipmentToken: 'seed-shipment-token', chargedFee: 3000 },
      { id: 'pickup-duplicate', kind: 'picked_up', shipmentToken: 'seed-shipment-token', chargedFee: 3000 }
    ]
  },
  deliveredBeforePickup: {
    signatureValid: true,
    events: [
      { id: 'delivered-early', kind: 'delivered', shipmentToken: 'seed-shipment-token' },
      { id: 'pickup-after-delivery', kind: 'picked_up', shipmentToken: 'seed-shipment-token', chargedFee: 3000 }
    ]
  },
  delayed: {
    signatureValid: true,
    delayMs: 250,
    events: [{ id: 'pickup-delayed', kind: 'picked_up', shipmentToken: 'seed-shipment-token', chargedFee: 3000 }]
  },
  timeout: { signatureValid: true, failure: 'timeout' },
  serverError: { signatureValid: true, failure: 'http_500' }
} satisfies Record<string, CourierScenario>;

export type CourierScenarioName = keyof typeof courierScenarios;

export type ScenarioDelivery = { readonly rawBody: Buffer; readonly signature: string };
export type ScenarioDeliveryBatch = {
  readonly deliveries: readonly ScenarioDelivery[];
  readonly delayMs?: number;
  readonly failure?: 'timeout' | 'http_500';
};

export function createScenarioDeliveries(name: CourierScenarioName, secret: string): ScenarioDeliveryBatch {
  const scenario: CourierScenario = courierScenarios[name];
  const deliveries = (scenario.events ?? []).map((event) => {
    const rawBody = Buffer.from(JSON.stringify(event));
    const validSignature = signWebhook(rawBody, secret);
    return {
      rawBody,
      signature: scenario.signatureValid ? validSignature : invalidWebhookSignature(validSignature)
    };
  });
  return {
    deliveries,
    ...(scenario.delayMs === undefined ? {} : { delayMs: scenario.delayMs }),
    ...(scenario.failure === undefined ? {} : { failure: scenario.failure })
  };
}
