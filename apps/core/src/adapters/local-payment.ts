import type { PaymentInstruction, PaymentProviderPort, PaymentProviderResult } from '../ports/payment-provider.js';

export class LocalPaymentProvider implements PaymentProviderPort {
  private readonly outcomes = new Map<string, PaymentProviderResult>();

  async submit(input: PaymentInstruction): Promise<PaymentProviderResult> {
    const existing = this.outcomes.get(input.idempotencyKey);
    if (existing) return existing;
    const result: PaymentProviderResult = {
      outcome: 'success',
      providerReference: `local-payment:${input.idempotencyKey}`
    };
    this.outcomes.set(input.idempotencyKey, result);
    return result;
  }
}
