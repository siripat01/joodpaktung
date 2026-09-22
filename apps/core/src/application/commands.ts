import type { SatangInput } from '../domain/money.js';

export type PaymentCommand =
  | { type: 'seller_accepted_and_funded'; orderId: string; eventKey: string }
  | { type: 'courier_pickup'; orderId: string; eventKey: string; chargedFee: SatangInput }
  | { type: 'courier_delivered'; orderId: string; eventKey: string }
  | { type: 'courier_charge_updated'; orderId: string; eventKey: string; chargedFee: SatangInput; finalized: boolean }
  | { type: 'courier_unavailable'; orderId: string; eventKey: string }
  | { type: 'operations_verify_fee'; orderId: string; eventKey: string; chargedFee: SatangInput; evidenceRef: string }
  | { type: 'buyer_confirmed' | 'buyer_disputed' | 'ship_by_expired' | 'verification_expired' | 'auto_release_expired'; orderId: string; eventKey: string }
  | { type: 'operations_resolve_refund' | 'operations_resolve_release'; orderId: string; eventKey: string; evidenceRef: string };

export type CommandContext = {
  readonly traceId?: string;
  readonly requestId?: string;
  readonly logger?: { info(fields: Record<string, unknown>, message?: string): void; error?(fields: Record<string, unknown>, message?: string): void };
};

export type CommandOutcome = 'processed' | 'duplicate-ignored' | 'rejected-invalid-transition';

export type CommandResult = {
  readonly outcome: CommandOutcome;
  readonly order: {
    readonly id: string;
    readonly state: string;
    readonly courier_paid_satang: string;
    readonly courier_charge_satang: string;
    readonly courier_charge_finalized: boolean;
    readonly delivered_at: string | null;
    readonly product_released_satang: string;
    readonly refunded_satang: string;
  };
  readonly event?: { readonly name: string; readonly eventKey: string };
  readonly releasedSatang?: string;
};
