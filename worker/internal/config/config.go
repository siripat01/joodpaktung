package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	DatabaseURL, CoreURL, WorkerID, Failpoint string
	PollInterval, LeaseDuration               time.Duration
	BatchSize                                 int
}

func Load() (Config, error) {
	c := Config{DatabaseURL: strings.TrimSpace(os.Getenv("DATABASE_URL")), CoreURL: strings.TrimSpace(os.Getenv("CORE_URL")), WorkerID: strings.TrimSpace(os.Getenv("WORKER_ID")), Failpoint: strings.TrimSpace(os.Getenv("WORKER_FAILPOINT"))}
	if c.CoreURL == "" {
		c.CoreURL = "http://core:3000"
	}
	var err error
	if c.PollInterval, err = positiveDuration("WORKER_POLL_INTERVAL", time.Second); err != nil {
		return c, err
	}
	if c.LeaseDuration, err = positiveDuration("WORKER_LEASE_DURATION", 30*time.Second); err != nil {
		return c, err
	}
	if c.BatchSize, err = positiveInt("WORKER_BATCH_SIZE", 16); err != nil {
		return c, err
	}
	if c.BatchSize > 64 {
		return c, fmt.Errorf("WORKER_BATCH_SIZE must be at most 64")
	}
	if c.DatabaseURL == "" {
		return c, fmt.Errorf("DATABASE_URL is required")
	}
	if c.WorkerID == "" {
		return c, fmt.Errorf("WORKER_ID is required")
	}
	if len(c.WorkerID) > 100 {
		return c, fmt.Errorf("WORKER_ID must be at most 100 bytes")
	}
	if c.Failpoint != "" && c.Failpoint != "after_timer_claim" && c.Failpoint != "before_outbox_ack" {
		return c, fmt.Errorf("unsupported WORKER_FAILPOINT %q", c.Failpoint)
	}
	return c, nil
}
func positiveDuration(k string, d time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv(k))
	if raw == "" {
		return d, nil
	}
	v, err := time.ParseDuration(raw)
	if err != nil || v <= 0 {
		return 0, fmt.Errorf("%s must be a positive duration", k)
	}
	return v, nil
}
func positiveInt(k string, d int) (int, error) {
	raw := strings.TrimSpace(os.Getenv(k))
	if raw == "" {
		return d, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil || v <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", k)
	}
	return v, nil
}
