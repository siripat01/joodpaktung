export const PAYMENT_STATES = [
  'Reserved',
  'PendingVerification',
  'PartiallyReleased',
  'Disputed',
  'Released',
  'Refunded'
] as const;

export type PaymentState = (typeof PAYMENT_STATES)[number];

export type PaymentTrigger =
  | { readonly type: 'ship_by_expired' }
  | { readonly type: 'courier_picked_up'; readonly chargedFee: number }
  | { readonly type: 'courier_delivered' }
  | { readonly type: 'courier_unavailable' }
  | { readonly type: 'operations_verify_fee'; readonly chargedFee: number }
  | { readonly type: 'verification_expired' }
  | { readonly type: 'buyer_confirmed' }
  | { readonly type: 'auto_release_expired' }
  | { readonly type: 'buyer_disputed' }
  | { readonly type: 'operations_resolve_refund' }
  | { readonly type: 'operations_resolve_release' };

export type TransitionResult = {
  readonly from: PaymentState;
  readonly to: PaymentState;
  readonly trigger: PaymentTrigger;
  readonly shippingRelease?: number;
};

export class DomainRejection extends Error {
  readonly code = 'invalid_transition' as const;
  readonly state: PaymentState;
  readonly triggerType: string;

  constructor(state: PaymentState, triggerType: string) {
    super(`invalid transition: ${state} + ${triggerType}`);
    this.name = 'DomainRejection';
    this.state = state;
    this.triggerType = triggerType;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
