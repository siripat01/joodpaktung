import {
  DomainRejection,
  type PaymentState,
  type PaymentTrigger,
  type TransitionResult
} from './types.js';
import { toSatang, type SatangInput } from './money.js';

export const SHIPPING_CAP = 4500;

export function releaseForPickup(chargedFee: SatangInput): bigint {
  let fee: bigint;
  try {
    fee = toSatang(chargedFee);
  } catch {
    throw new Error('invalid charged fee');
  }
  if (fee < 0n) throw new Error('invalid charged fee');
  return fee;
}

export function transition(state: PaymentState, trigger: PaymentTrigger): TransitionResult {
  switch (state) {
    case 'Reserved':
      if (trigger.type === 'ship_by_expired') {
        return { from: state, to: 'Refunded', trigger };
      }
      if (trigger.type === 'courier_picked_up') {
        return {
          from: state,
          to: 'Shipped',
          trigger,
          shippingRelease: releaseForPickup(trigger.chargedFee)
        };
      }
      if (trigger.type === 'courier_unavailable') {
        return { from: state, to: 'PendingVerification', trigger };
      }
      break;

    case 'PendingVerification':
      if (trigger.type === 'operations_verify_fee') {
        return {
          from: state,
          to: 'Shipped',
          trigger,
          shippingRelease: releaseForPickup(trigger.chargedFee)
        };
      }
      if (trigger.type === 'verification_expired') {
        return { from: state, to: 'Refunded', trigger };
      }
      break;

    case 'Shipped':
      if (trigger.type === 'courier_delivered' || trigger.type === 'courier_charge_updated') {
        return { from: state, to: state, trigger };
      }
      if (trigger.type === 'buyer_confirmed' || trigger.type === 'auto_release_expired') {
        return { from: state, to: 'Released', trigger };
      }
      if (trigger.type === 'buyer_disputed') {
        return { from: state, to: 'Disputed', trigger };
      }
      break;

    case 'Disputed':
      if (trigger.type === 'operations_resolve_refund') {
        return { from: state, to: 'Refunded', trigger };
      }
      if (trigger.type === 'operations_resolve_release') {
        return { from: state, to: 'Released', trigger };
      }
      break;

    case 'Released':
    case 'Refunded':
      break;
  }

  throw new DomainRejection(state, trigger.type);
}

export type { PaymentState, PaymentTrigger, TransitionResult } from './types.js';
export { DomainRejection } from './types.js';
