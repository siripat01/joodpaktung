package outbox

import (
	"context"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/kplus/conditional-payment-poc/worker/internal/store"
	"log/slog"
	"sync"
	"time"
)

type Delivery struct {
	ID, OrderID, Kind, NotificationKey, TraceID string
	Payload                                     map[string]any
}
type Deliverer interface {
	Deliver(context.Context, Delivery) error
}
type PermanentError struct{ Err error }

func (e PermanentError) Error() string { return e.Err.Error() }
func (e PermanentError) Unwrap() error { return e.Err }

type Store interface {
	Complete(context.Context, store.Kind, string, string) error
	Retry(context.Context, store.Kind, string, string, time.Duration) error
	Fail(context.Context, store.Kind, string, string) error
}
type Worker struct {
	Deliverer               Deliverer
	Store                   Store
	Logger                  *slog.Logger
	BaseBackoff, MaxBackoff time.Duration
	Failpoint               func(string) error
}

func (w *Worker) Process(ctx context.Context, item store.Work, traceID string) error {
	log := w.Logger
	if log == nil {
		log = slog.Default()
	}
	err := w.Deliverer.Deliver(ctx, Delivery{ID: item.ID, OrderID: item.OrderID, Kind: item.Kind, NotificationKey: item.NotificationKey, TraceID: traceID, Payload: item.Payload})
	if err != nil {
		var permanent PermanentError
		if errors.As(err, &permanent) {
			log.Error("outbox delivery permanently failed", "event", "outbox_failed", "trace_id", traceID, "outbox_id", item.ID, "order_id", item.OrderID, "attempt", item.Attempts, "outcome", "permanent_failure")
			return w.Store.Fail(ctx, store.Outbox, item.ID, item.LeaseToken)
		}
		delay := w.BaseBackoff
		if delay <= 0 {
			delay = time.Second
		}
		for i := 1; i < item.Attempts; i++ {
			delay *= 2
			if w.MaxBackoff > 0 && delay >= w.MaxBackoff {
				delay = w.MaxBackoff
				break
			}
		}
		log.Warn("outbox delivery retry", "event", "outbox_retried", "trace_id", traceID, "outbox_id", item.ID, "order_id", item.OrderID, "attempt", item.Attempts, "outcome", "retryable_failure")
		if e := w.Store.Retry(ctx, store.Outbox, item.ID, item.LeaseToken, delay); e != nil {
			return e
		}
		return err
	}
	if w.Failpoint != nil {
		if err := w.Failpoint("before_outbox_ack"); err != nil {
			return fmt.Errorf("before_outbox_ack: %w", err)
		}
	}
	return w.Store.Complete(ctx, store.Outbox, item.ID, item.LeaseToken)
}

type LoggingDeliverer struct {
	Logger    *slog.Logger
	mu        sync.Mutex
	delivered map[string]struct{}
}

func (d *LoggingDeliverer) Deliver(ctx context.Context, x Delivery) error {
	started := time.Now()
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.delivered == nil {
		d.delivered = map[string]struct{}{}
	}
	if _, ok := d.delivered[x.NotificationKey]; ok {
		d.Logger.InfoContext(ctx, "local notification deduplicated", "event", "provider_response", "trace_id", x.TraceID, "provider", "local_logging", "operation", x.Kind, "outbox_id", x.ID, "order_id", x.OrderID, "notification_key", x.NotificationKey, "outcome", "duplicate", "duration_ms", time.Since(started).Milliseconds())
		return nil
	}
	d.delivered[x.NotificationKey] = struct{}{}
	d.Logger.InfoContext(ctx, "local notification delivered", "event", "provider_response", "trace_id", x.TraceID, "provider", "local_logging", "operation", x.Kind, "outbox_id", x.ID, "order_id", x.OrderID, "notification_key", x.NotificationKey, "outcome", "success", "duration_ms", time.Since(started).Milliseconds())
	return nil
}

type DeliveryDB interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}
type DBDeliverer struct {
	DB     DeliveryDB
	Logger *slog.Logger
}

func (d *DBDeliverer) Deliver(ctx context.Context, x Delivery) error {
	started := time.Now()
	tag, err := d.DB.Exec(ctx, `INSERT INTO local_provider_deliveries(notification_key,outbox_id,order_id,kind) VALUES($1,$2,$3,$4) ON CONFLICT(notification_key) DO NOTHING`, x.NotificationKey, x.ID, x.OrderID, x.Kind)
	if err != nil {
		return err
	}
	outcome := "success"
	if tag.RowsAffected() == 0 {
		outcome = "duplicate"
	}
	d.Logger.InfoContext(ctx, "local provider delivery", "event", "provider_response", "trace_id", x.TraceID, "provider", "local_database", "operation", x.Kind, "outbox_id", x.ID, "order_id", x.OrderID, "notification_key", x.NotificationKey, "outcome", outcome, "duration_ms", time.Since(started).Milliseconds())
	return nil
}
