import { createHmac, timingSafeEqual } from 'node:crypto';

export type NormalizedCourierEvent =
  | { readonly kind: 'picked_up'; readonly eventKey: string; readonly shipmentToken: string; readonly chargedFee: number }
  | { readonly kind: 'delivered'; readonly eventKey: string; readonly shipmentToken: string }
  | { readonly kind: 'courier_charge_updated'; readonly eventKey: string; readonly shipmentToken: string; readonly chargedFee: number; readonly finalized: boolean };

export interface CourierProviderPort {
  verifyAndNormalize(input: { readonly rawBody: Buffer; readonly signature: string; readonly traceId?: string }): Promise<NormalizedCourierEvent>;
}

export class CourierWebhookError extends Error {
  constructor(readonly code: 'invalid_signature' | 'invalid_payload' | 'timeout' | 'retryable_failure' | 'permanent_rejection') {
    super(`courier verification failed: ${code}`);
    this.name = 'CourierWebhookError';
  }
}

type CourierPayload = {
  readonly id: string;
  readonly kind: string;
  readonly shipmentToken: string;
  readonly chargedFee?: number;
  readonly finalized?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSatang(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export class HmacCourierProvider implements CourierProviderPort {
  constructor(private readonly secret: string) {
    if (!secret) throw new Error('courier webhook secret is required');
  }

  async verifyAndNormalize(input: { readonly rawBody: Buffer; readonly signature: string }): Promise<NormalizedCourierEvent> {
    const supplied = Buffer.from(input.signature, 'hex');
    const expected = createHmac('sha256', this.secret).update(input.rawBody).digest();
    if (!/^[a-fA-F0-9]{64}$/.test(input.signature) || supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) {
      throw new CourierWebhookError('invalid_signature');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(input.rawBody.toString('utf8')) as unknown;
    } catch {
      throw new CourierWebhookError('invalid_payload');
    }
    if (!isRecord(payload) || !nonEmptyString(payload.id) || !nonEmptyString(payload.shipmentToken)) {
      throw new CourierWebhookError('invalid_payload');
    }
    const courierPayload = payload as unknown as CourierPayload;
    switch (courierPayload.kind) {
      case 'picked_up':
        if (!isSatang(courierPayload.chargedFee)) throw new CourierWebhookError('invalid_payload');
        return {
          kind: 'picked_up',
          eventKey: courierPayload.id,
          shipmentToken: courierPayload.shipmentToken,
          chargedFee: courierPayload.chargedFee
        };
      case 'delivered':
        return { kind: 'delivered', eventKey: courierPayload.id, shipmentToken: courierPayload.shipmentToken };
      case 'charge_updated':
        if (!isSatang(courierPayload.chargedFee) || typeof courierPayload.finalized !== 'boolean') {
          throw new CourierWebhookError('invalid_payload');
        }
        return {
          kind: 'courier_charge_updated',
          eventKey: courierPayload.id,
          shipmentToken: courierPayload.shipmentToken,
          chargedFee: courierPayload.chargedFee,
          finalized: courierPayload.finalized
        };
      default:
        throw new CourierWebhookError('invalid_payload');
    }
  }
}
