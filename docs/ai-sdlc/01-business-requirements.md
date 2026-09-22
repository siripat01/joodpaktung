# Business Requirements

## Product

**K+ โอนซื้อของ** is a conditional-payment transfer mode for K PLUS-style social-commerce purchases completed in Facebook, Instagram, or LINE chat. It holds the buyer's money and releases it in two stages:

1. Release only a courier-verified shipping fee after pickup.
2. Release the remaining product amount after buyer confirmation or the dispute window ends.

The product is a prototype. All visible user copy must be Thai and no real K PLUS logo may be used.

## Demo surfaces

One single-page app contains three live panels:

- **Buyer phone:** create payment, mock PIN, status timeline, confirm received, report problem.
- **Seller phone:** accept/reject order, receive system-issued shipment label/QR, see shipping and product releases.
- **Engineering Console:** state diagram, T-account ledger, green/red invariant status, event outcomes, simulated clock, chaos controls, and property-test progress.

No manual refresh is allowed. The UI must render only committed facts received through the realtime stream.

## Money and seed order

Seed order:

- Product: 1,290 THB
- Shipping: 45 THB
- Total held: 1,335 THB

Implementation stores money in integer satang, not floating point. The seed values are therefore 129000, 4500, and 133500 satang.

## Required states and transitions

Only these payment states exist:

| From | Trigger | To | Required effect |
|---|---|---|---|
| Reserved | Seller misses `ship_by` | Refunded | Refund full remaining amount |
| Reserved | Valid courier pickup | PartiallyReleased | Release courier `charged_fee`, capped by configured maximum |
| Reserved | Courier data unavailable/invalid | PendingVerification | Never guess a release amount |
| PendingVerification | Manual confirmation | PartiallyReleased | Release only verified shipping amount |
| PendingVerification | Confirmation deadline missed | Refunded | Refund full remaining amount |
| PartiallyReleased | Buyer confirms received | Released | Release remaining product amount |
| PartiallyReleased | Dispute window expires after delivered | Released | Release remaining product amount |
| PartiallyReleased | Buyer reports problem before auto-release | Disputed | Hold remaining amount |
| Disputed | Resolve in buyer's favour | Refunded | Refund remaining amount |
| Disputed | Resolve in seller's favour | Released | Release remaining amount |

Rules:

- `Reserved` begins only after the seller accepts and buyer funding succeeds. A seller rejection cancels the pre-payment intent; it creates no hold, ledger entry, or payment-state transition.
- In the POC, the Engineering Console's Operations role may perform `PendingVerification -> PartiallyReleased` only after recording a verified courier fee from operational evidence; seller input is never accepted as that evidence.
- The same demo-only Operations role resolves a dispute to either `Refunded` or `Released`; each resolution uses the normal locked, idempotent payment command and records an audit event.
- A `delivered` event received before `picked_up` is recorded as `rejected-invalid-transition` for its event key. It never advances state; retries of that same key are `duplicate-ignored`. A corrected courier event requires a new event key after pickup.
- Buyer cannot cancel unilaterally after seller acceptance.
- Shipment token is issued by the system and is bound 1:1 to the order.
- Seller-entered tracking numbers are never accepted as a release trigger.
- Courier shipping fee comes from signed courier data, never seller input.
- Invalid transitions are clean domain rejections, not crashes.

## Non-goals

- Real banking, courier, LINE, KYC, or authentication integrations.
- Production security scope beyond safe demo role switching.
- Marketplace or general chat platform features.
