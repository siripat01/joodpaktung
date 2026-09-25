package store

import (
	"os"
	"strings"
	"testing"
)

func TestClaimSQLUsesInjectedClockAndSkipLocked(t *testing.T) {
	source, err := os.ReadFile("claim.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, required := range []string{"clock_state", "SKIP LOCKED", "lease_until <= c.now_at"} {
		if !strings.Contains(text, required) {
			t.Fatalf("claim query missing %q", required)
		}
	}
}
