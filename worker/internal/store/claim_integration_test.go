package store

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"os"
	"testing"
	"time"
)

func integrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL is required")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("worker_test_%d", time.Now().UnixNano())
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	cfg.MaxConns = 4
	p, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Close(); _, _ = admin.Exec(ctx, "DROP SCHEMA "+schema+" CASCADE"); admin.Close() })
	return p
}
func prepareLeaseFixture(t *testing.T, p *pgxpool.Pool) {
	t.Helper()
	_, err := p.Exec(context.Background(), `CREATE TABLE clock_state(singleton boolean primary key,now_at timestamptz,updated_at timestamptz);CREATE TABLE timers(id uuid primary key,order_id uuid,kind text,due_at timestamptz,status text,lease_owner text,lease_until timestamptz,event_key text,payload jsonb,created_at timestamptz,updated_at timestamptz);CREATE TABLE outbox_events(id uuid primary key,order_id uuid,kind text,notification_key text,payload jsonb,status text,available_at timestamptz,lease_owner text,lease_until timestamptz,attempts int,created_at timestamptz,updated_at timestamptz);INSERT INTO clock_state VALUES(true,'2030-01-01','2030-01-01');INSERT INTO timers VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','ship_by_expired','2029-12-31','pending',null,null,'timer:key','{}',now(),now())`)
	if err != nil {
		t.Fatal(err)
	}
}
func TestPostgresClaimClockReclaimAndTokenFencing(t *testing.T) {
	p := integrationPool(t)
	prepareLeaseFixture(t, p)
	ctx := context.Background()
	a := New(p, "worker-a", time.Minute)
	b := New(p, "worker-b", time.Minute)
	first, err := a.ClaimDue(ctx, Timer, 1)
	if err != nil || len(first) != 1 {
		t.Fatalf("first=%v err=%v", first, err)
	}
	second, err := b.ClaimDue(ctx, Timer, 1)
	if err != nil || len(second) != 0 {
		t.Fatalf("second=%v err=%v", second, err)
	}
	if err = b.Complete(ctx, Timer, first[0].ID, first[0].LeaseToken); err == nil {
		t.Fatal("wrong worker token completed")
	}
	_, _ = p.Exec(ctx, "UPDATE timers SET lease_until=now()-interval '1 second'")
	c := New(p, "worker-a", time.Minute)
	reclaimed, err := c.ClaimDue(ctx, Timer, 1)
	if err != nil || len(reclaimed) != 1 {
		t.Fatalf("reclaim=%v err=%v", reclaimed, err)
	}
	if reclaimed[0].LeaseToken == first[0].LeaseToken {
		t.Fatal("claim token reused")
	}
	if err = a.Retry(ctx, Timer, first[0].ID, first[0].LeaseToken, time.Second); err == nil {
		t.Fatal("stale same-owner token accepted")
	}
	var dueBefore time.Time
	if err = p.QueryRow(ctx, "SELECT due_at FROM timers WHERE id=$1", reclaimed[0].ID).Scan(&dueBefore); err != nil {
		t.Fatal(err)
	}
	if err = c.Retry(ctx, Timer, reclaimed[0].ID, reclaimed[0].LeaseToken, 50*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	blocked, err := c.ClaimDue(ctx, Timer, 1)
	if err != nil || len(blocked) != 0 {
		t.Fatalf("operational retry claimed early %v %v", blocked, err)
	}
	time.Sleep(60 * time.Millisecond)
	ready, err := c.ClaimDue(ctx, Timer, 1)
	if err != nil || len(ready) != 1 {
		t.Fatalf("operational retry not reclaimed %v %v", ready, err)
	}
	var dueAfter time.Time
	if err = p.QueryRow(ctx, "SELECT due_at FROM timers WHERE id=$1", ready[0].ID).Scan(&dueAfter); err != nil {
		t.Fatal(err)
	}
	if !dueAfter.Equal(dueBefore) {
		t.Fatalf("business due_at changed: %v != %v", dueAfter, dueBefore)
	}
}
func TestPostgresClaimSkipsRowHeldByTransaction(t *testing.T) {
	p := integrationPool(t)
	prepareLeaseFixture(t, p)
	ctx := context.Background()
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, "SELECT id FROM timers FOR UPDATE"); err != nil {
		t.Fatal(err)
	}
	claimed, err := New(p, "worker-b", time.Minute).ClaimDue(ctx, Timer, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(claimed) != 0 {
		t.Fatalf("claimed locked row: %v", claimed)
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
}
func TestPostgresOutboxUsesWallClockAndBackoff(t *testing.T) {
	p := integrationPool(t)
	prepareLeaseFixture(t, p)
	ctx := context.Background()
	_, err := p.Exec(ctx, `INSERT INTO outbox_events VALUES('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','notify','notice:key','{}','pending',now()+interval '1 hour',null,null,0,now(),now())`)
	if err != nil {
		t.Fatal(err)
	}
	s := New(p, "worker", time.Minute)
	items, err := s.ClaimDue(ctx, Outbox, 1)
	if err != nil || len(items) != 0 {
		t.Fatalf("future outbox claimed %v %v", items, err)
	}
	_, _ = p.Exec(ctx, "UPDATE outbox_events SET available_at=now()-interval '1 second'")
	items, err = s.ClaimDue(ctx, Outbox, 1)
	if err != nil || len(items) != 1 {
		t.Fatalf("due outbox %v %v", items, err)
	}
	if err = s.Retry(ctx, Outbox, items[0].ID, items[0].LeaseToken, time.Minute); err != nil {
		t.Fatal(err)
	}
	var future bool
	if err = p.QueryRow(ctx, "SELECT available_at>now() FROM outbox_events WHERE id=$1", items[0].ID).Scan(&future); err != nil || !future {
		t.Fatalf("backoff future=%v err=%v", future, err)
	}
}
