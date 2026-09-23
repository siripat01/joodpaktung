import { createHmac, timingSafeEqual } from 'node:crypto';

export function signWebhook(rawBody: Buffer | string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifyWebhookSignature(rawBody: Buffer | string, signature: string, secret: string): boolean {
  if (!/^[a-fA-F0-9]{64}$/.test(signature)) return false;
  const actual = Buffer.from(signature, 'hex');
  const expected = Buffer.from(signWebhook(rawBody, secret), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function invalidWebhookSignature(signature: string): string {
  if (!/^[a-fA-F0-9]{64}$/.test(signature)) return '0'.repeat(64);
  return signature.slice(0, -1) + (signature.endsWith('0') ? '1' : '0');
}
