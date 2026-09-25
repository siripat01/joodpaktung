package outbox

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/kplus/conditional-payment-poc/worker/internal/store"
	"io"
	"log/slog"
	"testing"
	"time"
)

type fakeDeliverer struct {
	calls     int
	delivered map[string]struct{}
	err       error
}

func (f *fakeDeliverer) Deliver(_ context.Context, d Delivery) error {
	f.calls++
	if f.err == nil {
		if f.delivered == nil {
			f.delivered = map[string]struct{}{}
		}
		f.delivered[d.NotificationKey] = struct{}{}
	}
	return f.err
}

type fakeStore struct {
	completed, retried, failed int
	delay                      time.Duration
}

func (f *fakeStore) Complete(context.Context, store.Kind, string, string) error {
	f.completed++
	return nil
}
func (f *fakeStore) Retry(_ context.Context, _ store.Kind, _ string, _ string, d time.Duration) error {
	f.retried++
	f.delay = d
	return nil
}
func (f *fakeStore) Fail(context.Context, store.Kind, string, string) error { f.failed++; return nil }
func TestCrashBeforeAckRedeliversWithStableNotificationKey(t *testing.T) {
	d := &fakeDeliverer{}
	s := &fakeStore{}
	crash := true
	w := Worker{Deliverer: d, Store: s, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Failpoint: func(string) error {
		if crash {
			return errors.New("crash")
		}
		return nil
	}}
	item := store.Work{ID: "o1", NotificationKey: "event:e1"}
	if w.Process(context.Background(), item, "trace-1") == nil {
		t.Fatal("expected failpoint")
	}
	crash = false
	if err := w.Process(context.Background(), item, "trace-1"); err != nil {
		t.Fatal(err)
	}
	if d.calls != 2 || len(d.delivered) != 1 || s.completed != 1 {
		t.Fatalf("calls=%d unique_deliveries=%d completed=%d", d.calls, len(d.delivered), s.completed)
	}
}
func TestRetryBackoffAndPermanentFailure(t *testing.T) {
	s := &fakeStore{}
	d := &fakeDeliverer{err: errors.New("timeout")}
	w := Worker{Deliverer: d, Store: s, BaseBackoff: time.Second, MaxBackoff: 10 * time.Second}
	_ = w.Process(context.Background(), store.Work{ID: "o", Attempts: 3}, "trace-1")
	if s.retried != 1 || s.delay != 4*time.Second {
		t.Fatalf("retry=%d delay=%s", s.retried, s.delay)
	}
	d.err = PermanentError{Err: errors.New("rejected")}
	_ = w.Process(context.Background(), store.Work{ID: "o"}, "trace-1")
	if s.failed != 1 {
		t.Fatal("permanent failure not recorded")
	}
}

func TestLoggingDelivererDeduplicatesNotificationKey(t *testing.T) {
	d := &LoggingDeliverer{Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	delivery := Delivery{NotificationKey: "event:stable", Kind: "notify"}
	if err := d.Deliver(context.Background(), delivery); err != nil {
		t.Fatal(err)
	}
	if err := d.Deliver(context.Background(), delivery); err != nil {
		t.Fatal(err)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.delivered) != 1 {
		t.Fatalf("recorded deliveries = %d", len(d.delivered))
	}
}

type fakeDeliveryDB struct{ keys map[string]struct{} }

func (d *fakeDeliveryDB) Exec(_ context.Context, _ string, args ...any) (pgconn.CommandTag, error) {
	if d.keys == nil {
		d.keys = map[string]struct{}{}
	}
	key := args[0].(string)
	if _, ok := d.keys[key]; ok {
		return pgconn.NewCommandTag("INSERT 0 0"), nil
	}
	d.keys[key] = struct{}{}
	return pgconn.NewCommandTag("INSERT 0 1"), nil
}
func TestDBDelivererDeduplicatesAcrossDelivererRestart(t *testing.T) {
	db := &fakeDeliveryDB{}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	delivery := Delivery{ID: "00000000-0000-4000-8000-000000000001", OrderID: "00000000-0000-4000-8000-000000000002", NotificationKey: "stable", Kind: "notify"}
	if err := (&DBDeliverer{DB: db, Logger: logger}).Deliver(context.Background(), delivery); err != nil {
		t.Fatal(err)
	}
	if err := (&DBDeliverer{DB: db, Logger: logger}).Deliver(context.Background(), delivery); err != nil {
		t.Fatal(err)
	}
	if len(db.keys) != 1 {
		t.Fatalf("deliveries=%d", len(db.keys))
	}
}
