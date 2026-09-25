package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrLeaseLost = errors.New("work lease lost")

type Kind string

const (
	Timer  Kind = "timer"
	Outbox Kind = "outbox"
)

type Work struct {
	ID, OrderID, Kind, EventKey, NotificationKey, LeaseToken string
	Payload                                                  map[string]any
	Attempts                                                 int
}

type Store struct {
	pool  *pgxpool.Pool
	owner string
	lease time.Duration
}

func New(pool *pgxpool.Pool, owner string, lease time.Duration) *Store {
	return &Store{pool: pool, owner: owner, lease: lease}
}

// ClaimDue leases replayable work atomically. Only timer due-at uses demo time;
// leases and outbox availability deliberately use PostgreSQL wall time.
func (s *Store) ClaimDue(ctx context.Context, kind Kind, limit int) ([]Work, error) {
	if limit <= 0 {
		return nil, errors.New("claim limit must be positive")
	}
	table, due, key, dueNow := "timers", "due_at", "event_key", "(SELECT now_at FROM clock_state WHERE singleton=true)"
	attemptsSet, attemptsReturn := "", "0"
	if kind == Outbox {
		table, due, key, dueNow = "outbox_events", "available_at", "notification_key", "now()"
		attemptsSet = "attempts=q.attempts+1,"
		attemptsReturn = "q.attempts"
	} else if kind != Timer {
		return nil, fmt.Errorf("unknown work kind %q", kind)
	}
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	prefix := s.owner + ":" + hex.EncodeToString(nonce)
	query := fmt.Sprintf(`WITH candidate AS (SELECT q.id FROM %s q WHERE ((q.status='pending' AND q.%s<=%s AND (q.lease_until IS NULL OR q.lease_until<=now())) OR (q.status='leased' AND q.lease_until<=now())) ORDER BY q.%s,q.id FOR UPDATE OF q SKIP LOCKED LIMIT $1) UPDATE %s q SET status='leased',lease_owner=$2||':'||q.id::text,lease_until=now()+$3::interval,%s updated_at=now() FROM candidate WHERE q.id=candidate.id RETURNING q.id::text,q.order_id::text,q.kind,q.%s,q.payload,%s,q.lease_owner`, table, due, dueNow, due, table, attemptsSet, key, attemptsReturn)
	rows, err := s.pool.Query(ctx, query, limit, prefix, s.lease.String())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []Work
	for rows.Next() {
		var w Work
		var raw []byte
		var stable string
		if err := rows.Scan(&w.ID, &w.OrderID, &w.Kind, &stable, &raw, &w.Attempts, &w.LeaseToken); err != nil {
			return nil, err
		}
		if kind == Timer {
			w.EventKey = stable
		} else {
			w.NotificationKey = stable
		}
		if err := json.Unmarshal(raw, &w.Payload); err != nil {
			return nil, fmt.Errorf("decode %s %s payload: %w", kind, w.ID, err)
		}
		result = append(result, w)
	}
	return result, rows.Err()
}
func (s *Store) mutateLease(ctx context.Context, kind Kind, id, token, status, dueColumn string, delay time.Duration) error {
	table := "timers"
	if kind == Outbox {
		table = "outbox_events"
	}
	set := "status=$1,lease_owner=NULL,lease_until=NULL,updated_at=now()"
	args := []any{status, id, token}
	if dueColumn != "" {
		set += "," + dueColumn + "=now()+$4::interval"
		args = append(args, delay.String())
	}
	query := fmt.Sprintf("UPDATE %s SET %s WHERE id=$2 AND status='leased' AND lease_owner=$3 AND lease_until>now()", table, set)
	tag, err := s.pool.Exec(ctx, query, args...)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrLeaseLost
	}
	return nil
}
func (s *Store) Complete(ctx context.Context, kind Kind, id, token string) error {
	status := "completed"
	if kind == Outbox {
		status = "delivered"
	}
	return s.mutateLease(ctx, kind, id, token, status, "", 0)
}
func (s *Store) Retry(ctx context.Context, kind Kind, id, token string, delay time.Duration) error {
	if kind == Outbox {
		return s.mutateLease(ctx, kind, id, token, "pending", "available_at", delay)
	}
	// Timer due_at is business time and immutable during operational retries.
	tag, err := s.pool.Exec(ctx, `UPDATE timers SET status='pending',lease_owner=NULL,
		lease_until=now()+$1::interval,updated_at=now()
		WHERE id=$2 AND status='leased' AND lease_owner=$3 AND lease_until>now()`, delay.String(), id, token)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrLeaseLost
	}
	return nil
}
func (s *Store) Fail(ctx context.Context, kind Kind, id, token string) error {
	return s.mutateLease(ctx, kind, id, token, "failed", "", 0)
}
