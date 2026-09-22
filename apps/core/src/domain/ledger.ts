import { assertIntegerSatang, assertNonNegativeSatang } from './money.js';

export type LedgerAccount =
  | 'buyer_available'
  | 'hold_suspense'
  | 'seller_available'
  | 'buyer_refund';

export type LedgerPosting = {
  readonly account: LedgerAccount;
  readonly amountSatang: number;
};

function transfer(
  from: LedgerAccount,
  to: LedgerAccount,
  amountSatang: number
): LedgerPosting[] {
  assertNonNegativeSatang(amountSatang);
  if (amountSatang === 0) return [];
  return [
    { account: from, amountSatang: -amountSatang },
    { account: to, amountSatang }
  ];
}

export function postHold(amountSatang: number): LedgerPosting[] {
  return transfer('buyer_available', 'hold_suspense', amountSatang);
}

export function postShippingRelease(amountSatang: number): LedgerPosting[] {
  return transfer('hold_suspense', 'seller_available', amountSatang);
}

export function postProductRelease(amountSatang: number): LedgerPosting[] {
  return transfer('hold_suspense', 'seller_available', amountSatang);
}

export function postRefund(amountSatang: number): LedgerPosting[] {
  return transfer('hold_suspense', 'buyer_refund', amountSatang);
}

export function postHoldThenShipping(totalSatang: number, shippingSatang: number): LedgerPosting[] {
  assertNonNegativeSatang(totalSatang);
  assertNonNegativeSatang(shippingSatang);
  if (shippingSatang > totalSatang) {
    throw new Error('shipping release exceeds held amount');
  }
  return [...postHold(totalSatang), ...postShippingRelease(shippingSatang)];
}

export function assertBalanced(entries: readonly LedgerPosting[]): void {
  const balance = entries.reduce((sum, entry) => {
    assertIntegerSatang(entry.amountSatang);
    return sum + entry.amountSatang;
  }, 0);

  if (balance !== 0) {
    throw new Error('unbalanced ledger');
  }
}
