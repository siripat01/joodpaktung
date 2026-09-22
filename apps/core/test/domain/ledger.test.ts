import { describe, expect, it } from 'vitest';
import {
  assertBalanced,
  postHoldThenShipping,
  postProductRelease,
  postRefund,
  type LedgerPosting
} from '../../src/domain/ledger.js';

describe('ledger primitives', () => {
  it('creates balanced hold and capped shipping postings', () => {
    const entries = postHoldThenShipping(133500, 4500);

    expect(entries).toEqual([
      { account: 'buyer_available', amountSatang: -133500 },
      { account: 'hold_suspense', amountSatang: 133500 },
      { account: 'hold_suspense', amountSatang: -4500 },
      { account: 'seller_available', amountSatang: 4500 }
    ]);
    expect(assertBalanced(entries)).toBeUndefined();
  });

  it('posts the remaining product release to the seller', () => {
    const entries = postProductRelease(129000);

    expect(entries).toEqual([
      { account: 'hold_suspense', amountSatang: -129000 },
      { account: 'seller_available', amountSatang: 129000 }
    ]);
    expect(assertBalanced(entries)).toBeUndefined();
  });

  it('posts the remaining amount to the buyer refund account', () => {
    const entries = postRefund(133500);

    expect(entries).toEqual([
      { account: 'hold_suspense', amountSatang: -133500 },
      { account: 'buyer_refund', amountSatang: 133500 }
    ]);
    expect(assertBalanced(entries)).toBeUndefined();
  });

  it('rejects an unbalanced ledger', () => {
    const entries: LedgerPosting[] = [
      { account: 'hold_suspense', amountSatang: -4500 },
      { account: 'seller_available', amountSatang: 4499 }
    ];

    expect(() => assertBalanced(entries)).toThrow('unbalanced ledger');
  });

  it('rejects fractional ledger amounts', () => {
    const entries: LedgerPosting[] = [
      { account: 'hold_suspense', amountSatang: -4500.5 },
      { account: 'seller_available', amountSatang: 4500.5 }
    ];

    expect(() => assertBalanced(entries)).toThrow('invalid satang amount');
  });
});
