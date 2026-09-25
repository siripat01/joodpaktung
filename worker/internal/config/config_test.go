package config

import (
	"strings"
	"testing"
)

func TestLoadRequiresUniqueWorkerIDAndPositiveValues(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://local/test")
	t.Setenv("WORKER_ID", "")
	if _, err := Load(); err == nil {
		t.Fatal("missing worker id accepted")
	}
	t.Setenv("WORKER_ID", "worker-a")
	t.Setenv("WORKER_BATCH_SIZE", "0")
	if _, err := Load(); err == nil {
		t.Fatal("zero batch accepted")
	}
	t.Setenv("WORKER_BATCH_SIZE", "1")
	t.Setenv("WORKER_LEASE_DURATION", "-1s")
	if _, err := Load(); err == nil {
		t.Fatal("negative lease accepted")
	}
}
func TestLoadRejectsWorkerIDThatCannotFitLeaseToken(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://local/test")
	t.Setenv("WORKER_ID", strings.Repeat("w", 101))
	if _, err := Load(); err == nil {
		t.Fatal("oversized worker id accepted")
	}
}

func TestLoadRejectsOversizedBatch(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://local/test")
	t.Setenv("WORKER_ID", "worker-a")
	t.Setenv("WORKER_BATCH_SIZE", "65")
	if _, err := Load(); err == nil {
		t.Fatal("oversized batch accepted")
	}
}
