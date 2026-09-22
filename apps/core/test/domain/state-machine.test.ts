import { describe, expect, it } from 'vitest';
import {
  DomainRejection,
  type PaymentState,
  type PaymentTrigger
} from '../../src/domain/types.js';
import { releaseForPickup, transition } from '../../src/domain/state-machine.js';

describe('payment state machine', () => {
  it('caps pickup release and leaves the product held', () => {
    expect(transition('Reserved', { type: 'courier_picked_up', chargedFee: 9000 }))
      .toMatchObject({ to: 'PartiallyReleased', shippingRelease: 4500 });
  });

  it('rejects delivered before pickup without state change', () => {
    const delivered: PaymentTrigger = { type: 'courier_delivered' };

    expect(() => transition('Reserved', delivered))
      .toThrow('invalid transition: Reserved + courier_delivered');
  });

  it('accepts every approved legal transition', () => {
    const legalTransitions: ReadonlyArray<readonly [PaymentState, object, PaymentState]> = [
      ['Reserved', { type: 'ship_by_expired' }, 'Refunded'],
      ['Reserved', { type: 'courier_picked_up', chargedFee: 4500 }, 'PartiallyReleased'],
      ['Reserved', { type: 'courier_unavailable' }, 'PendingVerification'],
      ['PendingVerification', { type: 'operations_verify_fee', chargedFee: 4500 }, 'PartiallyReleased'],
      ['PendingVerification', { type: 'verification_expired' }, 'Refunded'],
      ['PartiallyReleased', { type: 'buyer_confirmed' }, 'Released'],
      ['PartiallyReleased', { type: 'auto_release_expired' }, 'Released'],
      ['PartiallyReleased', { type: 'buyer_disputed' }, 'Disputed'],
      ['Disputed', { type: 'operations_resolve_refund' }, 'Refunded'],
      ['Disputed', { type: 'operations_resolve_release' }, 'Released']
    ];

    for (const [state, trigger, to] of legalTransitions) {
      expect(transition(state, trigger as never)).toMatchObject({ from: state, to });
    }
  });

  it('rejects every trigger from an unapproved origin', () => {
    const states: PaymentState[] = [
      'Reserved',
      'PendingVerification',
      'PartiallyReleased',
      'Disputed',
      'Released',
      'Refunded'
    ];
    const triggers = [
      { type: 'ship_by_expired' },
      { type: 'courier_picked_up', chargedFee: 4500 },
      { type: 'courier_unavailable' },
      { type: 'operations_verify_fee', chargedFee: 4500 },
      { type: 'verification_expired' },
      { type: 'buyer_confirmed' },
      { type: 'auto_release_expired' },
      { type: 'buyer_disputed' },
      { type: 'operations_resolve_refund' },
      { type: 'operations_resolve_release' }
    ];
    const legalPairs = new Set([
      'Reserved:ship_by_expired',
      'Reserved:courier_picked_up',
      'Reserved:courier_unavailable',
      'PendingVerification:operations_verify_fee',
      'PendingVerification:verification_expired',
      'PartiallyReleased:buyer_confirmed',
      'PartiallyReleased:auto_release_expired',
      'PartiallyReleased:buyer_disputed',
      'Disputed:operations_resolve_refund',
      'Disputed:operations_resolve_release'
    ]);

    for (const state of states) {
      for (const trigger of triggers) {
        if (legalPairs.has(`${state}:${trigger.type}`)) continue;
        expect(() => transition(state, trigger as never)).toThrow(DomainRejection);
        expect(() => transition(state, trigger as never)).toThrow(
          `invalid transition: ${state} + ${trigger.type}`
        );
      }
    }
  });

  it('rejects non-integer or negative courier fees', () => {
    expect(() => releaseForPickup(1.5)).toThrow('invalid charged fee');
    expect(() => releaseForPickup(-1)).toThrow('invalid charged fee');
  });
});
