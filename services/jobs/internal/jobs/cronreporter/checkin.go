package cronreporter

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Telesis lifecycle states, appended to the private check-in URL:
// POST https://api.telesis.dev/v1/cron/<token>/{start,complete,fail}.
const (
	stateStart    = "start"
	stateComplete = "complete"
	stateFail     = "fail"
)

// Bounds the Telesis telemetry handler enforces (terminal_reason ≤1024 bytes,
// diagnostic_excerpt ≤16KiB, run_id ≤255). The excerpt is held well under its
// ceiling so the envelope never tips the request over the body limit.
const (
	maxReasonBytes     = 1024
	maxDiagnosticBytes = 8 * 1024
	maxRunIDBytes      = 255
)

// checkin is one lifecycle event for one Kubernetes Job run.
type checkin struct {
	State          string
	RunID          string
	DurationMs     int64
	ExitCode       *int
	TerminalReason string
	Diagnostic     string
	// IdempotencyKey makes a retried POST (reporter restarted between the send
	// and the annotation patch) a no-op on the Telesis side.
	IdempotencyKey string
}

type checkinBody struct {
	RunID             string `json:"run_id,omitempty"`
	DurationMs        int64  `json:"duration_ms,omitempty"`
	ExitCode          *int   `json:"exit_code,omitempty"`
	TerminalReason    string `json:"terminal_reason,omitempty"`
	DiagnosticExcerpt string `json:"diagnostic_excerpt,omitempty"`
}

// sender delivers a check-in to a monitor's private URL.
type sender interface {
	Send(ctx context.Context, checkinURL string, c checkin) error
}

// permanentError is a check-in Telesis rejected outright (4xx other than 408 /
// 429): an unknown or rotated token, or a payload it will never accept. Retrying
// it every poll would only spam the log, so the reporter records the rejection
// on the Job and moves on.
type permanentError struct {
	Status int
	Body   string
}

func (e *permanentError) Error() string {
	return fmt.Sprintf("check-in rejected: HTTP %d: %s", e.Status, e.Body)
}

func isPermanent(err error) (*permanentError, bool) {
	var p *permanentError
	ok := errors.As(err, &p)
	return p, ok
}

type httpSender struct {
	client    *http.Client
	userAgent string
}

func newHTTPSender() *httpSender {
	return &httpSender{
		client:    &http.Client{Timeout: 15 * time.Second},
		userAgent: "shorted-cronjob-reporter/1.0 (+https://shorted.com.au)",
	}
}

func (s *httpSender) Send(ctx context.Context, checkinURL string, c checkin) error {
	body, err := json.Marshal(checkinBody{
		RunID:             clip(c.RunID, maxRunIDBytes),
		DurationMs:        c.DurationMs,
		ExitCode:          c.ExitCode,
		TerminalReason:    clip(c.TerminalReason, maxReasonBytes),
		DiagnosticExcerpt: tail(c.Diagnostic, maxDiagnosticBytes),
	})
	if err != nil {
		return err
	}
	endpoint := strings.TrimRight(checkinURL, "/") + "/" + c.State
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", s.userAgent)
	if c.IdempotencyKey != "" {
		req.Header.Set("Idempotency-Key", c.IdempotencyKey)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		// Never echo the URL: it IS the credential.
		return fmt.Errorf("check-in %s: %w", c.State, redactURLError(err))
	}
	defer func() { _ = resp.Body.Close() }()
	snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	switch {
	case resp.StatusCode/100 == 2:
		return nil
	case resp.StatusCode == http.StatusRequestTimeout, resp.StatusCode == http.StatusTooManyRequests:
		return fmt.Errorf("check-in %s: transient HTTP %d", c.State, resp.StatusCode)
	case resp.StatusCode/100 == 4:
		return &permanentError{Status: resp.StatusCode, Body: strings.TrimSpace(string(snippet))}
	default:
		return fmt.Errorf("check-in %s: HTTP %d", c.State, resp.StatusCode)
	}
}

// redactURLError strips the request URL out of a *url.Error so the private
// check-in token never reaches the logs.
func redactURLError(err error) error {
	type unwrapper interface{ Unwrap() error }
	if u, ok := err.(unwrapper); ok && u.Unwrap() != nil {
		return u.Unwrap()
	}
	return err
}

// clip keeps the first n bytes, cutting on a rune boundary.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	s = s[:n]
	for len(s) > 0 && !validTail(s) {
		s = s[:len(s)-1]
	}
	return s
}

// tail keeps the LAST n bytes — for logs, the end is where the failure is.
func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	s = s[len(s)-n:]
	for len(s) > 0 && (s[0]&0xC0) == 0x80 { // drop a split continuation byte
		s = s[1:]
	}
	return s
}

func validTail(s string) bool {
	last := s[len(s)-1]
	if last < 0x80 {
		return true
	}
	// Walk back to the lead byte and check the sequence is complete.
	i := len(s) - 1
	for i > 0 && (s[i]&0xC0) == 0x80 {
		i--
	}
	lead := s[i]
	need := 1
	switch {
	case lead&0xE0 == 0xC0:
		need = 2
	case lead&0xF0 == 0xE0:
		need = 3
	case lead&0xF8 == 0xF0:
		need = 4
	}
	return len(s)-i == need
}
