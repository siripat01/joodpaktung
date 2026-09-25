package timers

import (
	"context"
	"github.com/kplus/conditional-payment-poc/worker/internal/coreclient"
	"github.com/kplus/conditional-payment-poc/worker/internal/store"
	"testing"
)

type fakeCore struct{ got coreclient.Command }

func (f *fakeCore) Submit(_ context.Context, c coreclient.Command, _ string) (coreclient.CommandResult, error) {
	f.got = c
	return coreclient.CommandResult{Outcome: "processed", TimerCompleted: true}, nil
}

func TestDispatchUsesPersistedStableEventKey(t *testing.T) {
	c := &fakeCore{}
	d := Dispatcher{Core: c}
	err := d.Dispatch(context.Background(), store.Work{ID: "timer-id", OrderID: "order-id", Kind: "ship_by_expired", EventKey: "timer:fund:ship_by_expired", Payload: map[string]any{}, LeaseToken: "lease-token-123456"}, "trace-1")
	if err != nil {
		t.Fatal(err)
	}
	if c.got["eventKey"] != "timer:fund:ship_by_expired" {
		t.Fatalf("event key = %v", c.got["eventKey"])
	}
}
