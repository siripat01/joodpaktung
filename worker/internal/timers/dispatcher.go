package timers

import (
	"context"
	"fmt"

	"github.com/kplus/conditional-payment-poc/worker/internal/coreclient"
	"github.com/kplus/conditional-payment-poc/worker/internal/store"
)

type Dispatcher struct{ Core coreclient.Submitter }

func (d *Dispatcher) Dispatch(ctx context.Context, w store.Work, traceID string) error {
	cmd := coreclient.Command{"type": w.Kind, "orderId": w.OrderID, "eventKey": w.EventKey, "leaseToken": w.LeaseToken}
	for k, v := range w.Payload {
		if k != "type" && k != "orderId" && k != "eventKey" {
			cmd[k] = v
		}
	}
	result, err := d.Core.Submit(ctx, cmd, traceID)
	if err != nil {
		return err
	}
	if result.Outcome == "" {
		return fmt.Errorf("core returned empty outcome")
	}
	if !result.TimerCompleted {
		return fmt.Errorf("core did not complete timer")
	}
	return nil
}
