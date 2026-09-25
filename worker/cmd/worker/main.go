package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kplus/conditional-payment-poc/worker/internal/config"
	"github.com/kplus/conditional-payment-poc/worker/internal/coreclient"
	"github.com/kplus/conditional-payment-poc/worker/internal/observability"
	"github.com/kplus/conditional-payment-poc/worker/internal/outbox"
	"github.com/kplus/conditional-payment-poc/worker/internal/store"
	"github.com/kplus/conditional-payment-poc/worker/internal/timers"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

func traceID() string { b := make([]byte, 16); _, _ = rand.Read(b); return hex.EncodeToString(b) }
func main() {
	logger := observability.New(os.Stdout)
	cfg, err := config.Load()
	if err != nil {
		logger.Error("configuration rejected", "event", "worker_start", "outcome", "failed", "error_type", "invalid_config")
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		logger.Error("database connection failed", "event", "worker_start", "outcome", "failed")
		os.Exit(1)
	}
	defer pool.Close()
	st := store.New(pool, cfg.WorkerID, cfg.LeaseDuration)
	timer := timers.Dispatcher{Core: coreclient.New(cfg.CoreURL, &http.Client{Timeout: 10 * time.Second})}
	sink := &outbox.DBDeliverer{DB: pool, Logger: logger}
	out := outbox.Worker{Deliverer: sink, Store: st, Logger: logger, BaseBackoff: time.Second, MaxBackoff: time.Minute}
	failpoint := func(name string) error {
		if cfg.Failpoint == name {
			logger.Warn("failpoint activated", "event", "failpoint_activated", "outcome", "activated", "failpoint", name)
			return errors.New("failpoint activated")
		}
		return nil
	}
	out.Failpoint = failpoint
	logger.Info("worker started", "event", "worker_start", "outcome", "success")
	ticker := time.NewTicker(cfg.PollInterval)
	defer ticker.Stop()
	for {
		if err := run(ctx, st, &timer, &out, cfg.BatchSize, logger, failpoint); err != nil && !errors.Is(err, context.Canceled) {
			logger.Error("worker cycle failed", "event", "worker_cycle", "outcome", "failed", "error_type", "cycle_error")
		}
		select {
		case <-ctx.Done():
			logger.Info("worker stopped", "event", "worker_shutdown", "outcome", "success")
			return
		case <-ticker.C:
		}
	}
}
func concurrently(items []store.Work, process func(store.Work) error) error {
	errs := make(chan error, len(items))
	var wg sync.WaitGroup
	for _, item := range items {
		item := item
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := process(item); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	var all []error
	for err := range errs {
		all = append(all, err)
	}
	return errors.Join(all...)
}
func run(ctx context.Context, st *store.Store, t *timers.Dispatcher, o *outbox.Worker, n int, logger *slog.Logger, failpoint func(string) error) error {
	timerItems, err := st.ClaimDue(ctx, store.Timer, n)
	if err != nil {
		return err
	}
	timerErr := concurrently(timerItems, func(x store.Work) error {
		trace := traceID()
		logger.Info("timer claimed", "event", "timer_claimed", "trace_id", trace, "timer_id", x.ID, "order_id", x.OrderID, "event_key", x.EventKey, "outcome", "leased")
		if err := failpoint("after_timer_claim"); err != nil {
			return err
		}
		if err := t.Dispatch(ctx, x, trace); err != nil {
			retryErr := st.Retry(ctx, store.Timer, x.ID, x.LeaseToken, time.Second)
			if errors.Is(retryErr, store.ErrLeaseLost) {
				logger.Warn("timer lease lost", "event", "timer_lease_lost", "trace_id", trace, "timer_id", x.ID, "order_id", x.OrderID, "outcome", "lost")
			}
			logger.Warn("timer retry", "event", "timer_retried", "trace_id", trace, "timer_id", x.ID, "order_id", x.OrderID, "outcome", "retryable_failure")
			return errors.Join(err, retryErr)
		}
		logger.Info("timer completed by core", "event", "timer_acknowledged", "trace_id", trace, "timer_id", x.ID, "order_id", x.OrderID, "outcome", "completed")
		return nil
	})
	outboxItems, err := st.ClaimDue(ctx, store.Outbox, n)
	if err != nil {
		return errors.Join(timerErr, err)
	}
	outboxErr := concurrently(outboxItems, func(x store.Work) error {
		trace := traceID()
		logger.Info("outbox claimed", "event", "outbox_claimed", "trace_id", trace, "outbox_id", x.ID, "order_id", x.OrderID, "attempt", x.Attempts, "outcome", "leased")
		err := o.Process(ctx, x, trace)
		if errors.Is(err, store.ErrLeaseLost) {
			logger.Warn("outbox lease lost", "event", "outbox_lease_lost", "trace_id", trace, "outbox_id", x.ID, "order_id", x.OrderID, "outcome", "lost")
		}
		if err == nil {
			logger.Info("outbox acknowledged", "event", "outbox_acknowledged", "trace_id", trace, "outbox_id", x.ID, "order_id", x.OrderID, "outcome", "delivered")
		}
		return err
	})
	return errors.Join(timerErr, outboxErr)
}
