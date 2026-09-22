export type Satang = number & { readonly __satang: unique symbol };

export function isIntegerSatang(value: number): value is Satang {
  return Number.isSafeInteger(value);
}

export function assertIntegerSatang(value: number): asserts value is Satang {
  if (!isIntegerSatang(value)) {
    throw new Error('invalid satang amount');
  }
}

export function toSatang(value: number): Satang {
  assertIntegerSatang(value);
  return value;
}

export function assertNonNegativeSatang(value: number): asserts value is Satang {
  assertIntegerSatang(value);
  if (value < 0) {
    throw new Error('invalid satang amount');
  }
}
