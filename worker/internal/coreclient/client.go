package coreclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type Command map[string]any
type CommandResult struct {
	Outcome        string `json:"outcome"`
	TimerCompleted bool   `json:"timerCompleted"`
}
type Submitter interface {
	Submit(context.Context, Command, string) (CommandResult, error)
}
type Client struct {
	baseURL string
	http    *http.Client
}

func New(baseURL string, h *http.Client) *Client {
	if h == nil {
		h = http.DefaultClient
	}
	return &Client{strings.TrimRight(baseURL, "/"), h}
}
func (c *Client) Submit(ctx context.Context, command Command, traceID string) (CommandResult, error) {
	var out CommandResult
	b, err := json.Marshal(command)
	if err != nil {
		return out, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/commands", bytes.NewReader(b))
	if err != nil {
		return out, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Trace-ID", traceID)
	resp, err := c.http.Do(req)
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return out, fmt.Errorf("core status %d: %s", resp.StatusCode, string(snippet))
	}
	if err = json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return out, err
	}
	return out, nil
}
