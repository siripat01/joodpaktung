import { assertIntegerSatang, assertNonNegativeSatang, toSatang, type SatangInput } from './money.js';

export type LedgerAccount =
  | 'buyer_available'
  | 'hold_suspense'
  | 'courier_payable'
  | 'seller_available'
  | 'buyer_refund';

export type LedgerPosting = {
  readonly account: LedgerAccount;
  readonly amountSatang: bigint;
};

function transfer(
  from: LedgerAccount,
  to: LedgerAccount,
  amountSatang: SatangInput
): LedgerPosting[] {
  const amount = toSatang(amountSatang);
  assertNonNegativeSatang(amount);
  if (amount === 0n) return [];
  return [
    { account: from, amountSatang: -amount },
    { account: to, amountSatang: amount }
  ];
}

export function postHold(amountSatang: SatangInput): LedgerPosting[] {
  return transfer('buyer_available', 'hold_suspense', amountSatang);
}

export function postCourierCharge(amountSatang: SatangInput): LedgerPosting[] {
  return transfer('hold_suspense', 'courier_payable', amountSatang);
}

export function postCourierChargeAdjustment(previousSatang: SatangInput, nextSatang: SatangInput): LedgerPosting[] {
  const previous = toSatang(previousSatang);
  const next = toSatang(nextSatang);
  assertNonNegativeSatang(previous);
  assertNonNegativeSatang(next);
  if (next > previous) return transfer('hold_suspense', 'courier_payable', next - previous);
  return transfer('courier_payable', 'hold_suspense', previous - next);
}

export function postProductRelease(amountSatang: SatangInput): LedgerPosting[] {
  return transfer('hold_suspense', 'seller_available', amountSatang);
}

export function postRefund(amountSatang: SatangInput): LedgerPosting[] {
  return transfer('hold_suspense', 'buyer_refund', amountSatang);
}

export function postHoldThenShipping(totalSatang: SatangInput, shippingSatang: SatangInput): LedgerPosting[] {
  const total = toSatang(totalSatang);
  const shipping = toSatang(shippingSatang);
  assertNonNegativeSatang(total);
  assertNonNegativeSatang(shipping);
  if (shipping > total) {
    throw new Error('shipping release exceeds held amount');
  }
  return [...postHold(total), ...postCourierCharge(shipping)];
}

export function assertBalanced(entries: readonly LedgerPosting[]): void {
  const balance = entries.reduce((sum, entry) => {
    assertIntegerSatang(entry.amountSatang);
    return sum + entry.amountSatang;
  }, 0n);

  if (balance !== 0n) {
    throw new Error('unbalanced ledger');
  }
}
