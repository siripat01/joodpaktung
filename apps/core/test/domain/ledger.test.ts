import { describe, expect, it } from 'vitest';
import {
  assertBalanced,
  postHoldThenShipping,
  postCourierCharge,
  postCourierChargeAdjustment,
  postProductRelease,
  postRefund,
  type LedgerPosting
} from '../../src/domain/ledger.js';

describe('ledger primitives', () => {
  it('creates balanced hold and courier payable postings', () => {
    const entries = postHoldThenShipping(133500, 4500);

    expect(entries).toEqual([
      { account: 'buyer_available', amountSatang: -133500n },
      { account: 'hold_suspense', amountSatang: 133500n },
      { account: 'hold_suspense', amountSatang: -4500n },
      { account: 'courier_payable', amountSatang: 4500n }
    ]);
    expect(assertBalanced(entries)).toBeUndefined();
  });

  it('posts the verified courier charge to courier payable, never seller available', () => {
    const entries = postCourierCharge(3000);

    expect(entries).toEqual([
      { account: 'hold_suspense', amountSatang: -3000n },
      { account: 'courier_payable', amountSatang: 3000n }
    ]);
    expect(entries.some((entry) => entry.account === 'seller_available')).toBe(false);
    expect(assertBalanced(entries)).toBeUndefined();
  });

  it('posts signed courier charge adjustments as balanced append-only transfers', () => {
    const entries = postCourierChargeAdjustment(3000n, 5000n);

    expect(entries).toEqual([
      { account: 'hold_suspense', amountSatang: -2000n },
      { account: 'courier_payable', amountSatang: 2000n }
    ]);
    expect(assertBalanced(entries)).toBeUndefined();
  });

  it('posts the remaining product release to the seller', () => {
    const entries = postProductRelease(129000);

    expect(entries).toEqual([
      { account: 'hold_suspense', amountSatang: -129000n },
      { account: 'seller_available', amountSatang: 129000n }
    ]);
    expect(assertBalanced(entries)).toBeUndefined();
  });

  it('posts the remaining amount to the buyer refund account', () => {
    const entries = postRefund(133500);

    expect(entries).toEqual([
      { account: 'hold_suspense', amountSatang: -133500n },
      { account: 'buyer_refund', amountSatang: 133500n }
    ]);
    expect(assertBalanced(entries)).toBeUndefined();
  });

  it('rejects an unbalanced ledger', () => {
    const entries: LedgerPosting[] = [
      { account: 'hold_suspense', amountSatang: -4500n },
      { account: 'seller_available', amountSatang: 4499n }
    ];

    expect(() => assertBalanced(entries)).toThrow('unbalanced ledger');
  });

  it('rejects fractional ledger amounts', () => {
    const entries: LedgerPosting[] = [
      { account: 'hold_suspense', amountSatang: -4500.5 as never },
      { account: 'seller_available', amountSatang: 4500.5 as never }
    ];

    expect(() => assertBalanced(entries)).toThrow('invalid satang amount');
  });
});
