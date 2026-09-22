# Provider Adapters, Mocks, and Observability

## Design objective

The offline POC must never depend on a real KBank, courier, or LINE account. At the same time, replacing a mock with a provider must not leak provider-specific payloads into domain rules.

Use Ports and Adapters:

1. The core emits canonical commands/events, for example `ShipmentPickedUp`, `NotificationRequested`, or `ReleaseInstructionRequested`.
2. A port defines the provider-neutral operation and normalized return type.
3. A local adapter is the default implementation in Docker Compose.
4. A provider adapter is selected only by configuration and is exercised through the same contract suite.
5. Logging and fault injection wrap either adapter as decorators.

Do not build a generic “switch provider” abstraction beyond these three ports. The POC has only three external boundaries.

## Default local mocks

| Boundary | Default mock | Why it is local |
|---|---|---|
| KBank/payment | `LocalPaymentProvider` inside the test/demo environment | No real banking API or credential is in scope; ledger remains authoritative |
| Courier | Custom `MockCourier` service | Must issue tokens, sign webhooks, and deterministically duplicate/delay/reorder events |
| LINE/chat | `LocalChatNotificationProvider` | The requirement forbids real LINE branding and the demo must work offline |

Use Mockoon only for simple static provider stubs or exploratory OpenAPI fixtures. Mockoon is free/open source, supports OpenAPI import/export, runs locally without an account, and can run through CLI/Docker. It is not the primary courier mock because the courier requires deterministic stateful chaos controls. [Mockoon FAQ](https://mockoon.com/faq/)

## Provider sandbox/test-mode research

These are optional learning spikes, not dependencies of the demo.

| Provider area | Finding | Decision for this POC |
|---|---|---|
| KBank payment APIs | KBank's API Portal states that developers can register an app and test APIs; product access and approval conditions vary by API. [KBank API Portal](https://apiportal.kasikornbank.com/) | Keep a local payment mock. Verify the exact product, terms, credentials, and sandbox availability only if a post-POC KBank integration is approved. |
| LINE Messaging API | LINE supports real Messaging API webhooks and a webhook test endpoint; testing uses a real LINE Official Account/channel rather than an offline mock. [LINE Messaging API reference](https://developers.line.biz/en/reference/messaging-api) | Keep generic local chat notifications. A LINE adapter is future work and must remain optional. |
| EasyPost courier API | Shipment objects support `test` mode. [EasyPost Shipment docs](https://docs.easypost.com/docs/shipments) | Useful only to learn a carrier-aggregation contract; not a Thai courier and not needed for the demo. |
| Shippo courier API | Test mode supports rates and test labels without charges. [Shippo authentication docs](https://docs.goshippo.com/docs/guides_general/authentication/) | Optional sandbox spike; do not make it a demo dependency. |
| Easyship courier API | Provides a sandbox environment for API testing, with a limited courier list. [Easyship sandbox docs](https://developers.easyship.com/docs/sandbox) | Optional sandbox spike; not a substitute for deterministic local chaos. |

No verified, free, public sandbox for a Thai courier is selected. The custom `MockCourier` is therefore the required implementation.

## Adapter contract rules

- Every outgoing operation includes `trace_id`, `order_id`, and an idempotency/notification key as applicable.
- Every incoming courier webhook is verified and normalized before the Payment Core sees it.
- A provider adapter translates provider errors into one of: `retryable_failure`, `permanent_rejection`, `invalid_payload`, or `timeout`.
- No provider adapter chooses a payment state or amount; it supplies evidence only.
- Contract fixtures must cover success, timeout, 500, malformed payload, duplicate response/event, and delayed response.

## Structured logging standard

Write logs at important boundaries, not every source line. Required events include:

- HTTP request start/end and rejected request;
- command received, deduplicated, rejected, committed, and rolled back;
- order lock acquired/waited, ledger posted, invariant passed/failed;
- timer/outbox claimed, retried, lease expired, delivered, and acknowledged;
- provider request/response/error and webhook verification result;
- SSE connection, reconnect, event delivery, and stream error; and
- Go worker start, graceful shutdown, panic recovery, benchmark, and failpoint activation.

Required shared fields:

```text
timestamp, level, service, event, trace_id, request_id, order_id,
event_key, timer_id, outbox_id, provider, attempt, outcome, duration_ms
```

Apply fields only when relevant; missing IDs are preferable to invented values.

## Redaction and retention

Never log:

- mock PIN values;
- API tokens, HMAC secrets, authorization headers, or raw signatures;
- raw payment credentials;
- full recipient addresses, phone numbers, or personal names.

Log safe references or hashes where correlation is needed. Logs are for diagnosis and expire/rotate in local development; ledger entries and domain events are the durable audit evidence.
