package main

import (
	"github.com/kplus/conditional-payment-poc/worker/internal/store"
	"sync/atomic"
	"testing"
	"time"
)

func TestClaimedBatchStartsBeforeSlowHandlersFinish(t *testing.T) {
	items := make([]store.Work, 16)
	release := make(chan struct{})
	var started atomic.Int32
	done := make(chan error, 1)
	go func() { done <- concurrently(items, func(store.Work) error { started.Add(1); <-release; return nil }) }()
	deadline := time.After(time.Second)
	for started.Load() != 16 {
		select {
		case <-deadline:
			t.Fatalf("only %d handlers started", started.Load())
		default:
			time.Sleep(time.Millisecond)
		}
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
