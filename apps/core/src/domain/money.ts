export type Satang = bigint;
export type SatangInput = bigint | number | string;

export function toSatang(value: SatangInput): Satang {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('invalid satang amount');
    return BigInt(value);
  }
  if (!/^-?\d+$/.test(value)) throw new Error('invalid satang amount');
  return BigInt(value);
}

export function isIntegerSatang(value: SatangInput): value is Satang {
  try {
    toSatang(value);
    return true;
  } catch {
    return false;
  }
}

export function assertIntegerSatang(value: SatangInput): asserts value is Satang {
  toSatang(value);
}

export function assertNonNegativeSatang(value: SatangInput): asserts value is Satang {
  const satang = toSatang(value);
  if (satang < 0n) throw new Error('invalid satang amount');
}
