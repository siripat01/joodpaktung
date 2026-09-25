# Lease worker

The worker leases due timers and outbox records with fencing tokens. Only timer `due_at` comparisons use the injectable `clock_state`; outbox availability, retry backoff, leases, and fencing use PostgreSQL `now()` so advancing demo time cannot steal live work.

Timer state transitions and timer completion happen atomically inside Payment Core. A timer command carries its claim token; Core completes only the matching, leased, unexpired timer. The worker never completes timers or writes financial tables.

The local provider records notification keys in `local_provider_deliveries`, which makes repeated delivery idempotent across worker restarts. This table is provider delivery state, not a financial or Core audit table.

`WORKER_FAILPOINT` supports `after_timer_claim` and `before_outbox_ack`. The `after_domain_commit` boundary belongs to Payment Core because only Core can observe its transaction commit; the worker recovery equivalent is `before_outbox_ack`, which proves stable provider delivery across a crash.
