export type PaymentInstruction = {
  readonly traceId: string;
  readonly orderId: string;
  readonly idempotencyKey: string;
  readonly action: 'reserve' | 'release' | 'refund';
  readonly amountSatang: string;
};

export type ProviderOutcome = 'success' | 'retryable_failure' | 'permanent_rejection' | 'timeout' | 'invalid_payload';

export type PaymentProviderResult = {
  readonly outcome: ProviderOutcome;
  readonly providerReference?: string;
};

export interface PaymentProviderPort {
  submit(input: PaymentInstruction): Promise<PaymentProviderResult>;
}
