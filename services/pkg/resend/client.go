// Package resend is the shared client for Resend's single-email endpoint,
// POST /emails. The alerts evaluator sends one email per event: each event has
// its own idempotency key, so a crash and retry inside Resend's 24-hour window
// is deduplicated, and one bad address cannot fail the rest of the batch. The
// broadcast sender still posts batches directly; migrating it is a follow-up.
//
// Errors are *SendError values. Callers branch on Kind, never on the message,
// because the message can carry recipient detail. Only the Resend error name is
// kept, and only when it is a plain identifier.
package resend

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// DefaultBaseURL is the production API origin.
const DefaultBaseURL = "https://api.resend.com"

// maxRetryAfter caps how long a 429's Retry-After can hold a send.
const maxRetryAfter = 5 * time.Second

// Client sends email through Resend.
type Client struct {
	APIKey  string
	BaseURL string // empty means DefaultBaseURL
	HTTP    *http.Client
}

// Tag is a Resend tag: name and value, both plain identifiers.
type Tag struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Email is the body of POST /emails.
type Email struct {
	From        string            `json:"from"`
	To          []string          `json:"to"`
	ReplyTo     string            `json:"reply_to,omitempty"`
	Subject     string            `json:"subject"`
	HTML        string            `json:"html"`
	Text        string            `json:"text"`
	Headers     map[string]string `json:"headers,omitempty"`
	Tags        []Tag             `json:"tags,omitempty"`
	Attachments []Attachment      `json:"attachments,omitempty"`
}

// Attachment is one file on an email. Content is the file's bytes, base64
// encoded. A ContentID makes the file inline: the HTML refers to it as
// <img src="cid:ID">, and Resend embeds it instead of listing it as a download.
type Attachment struct {
	Filename    string `json:"filename"`
	Content     string `json:"content"`
	ContentType string `json:"content_type,omitempty"`
	ContentID   string `json:"content_id,omitempty"`
}

// Kind classifies a failed send. What the caller does next depends on it.
type Kind int

const (
	// KindPermanent: the email will never be accepted as sent (validation,
	// a rejected idempotency reuse). Retrying the same request will not help.
	KindPermanent Kind = iota + 1
	// KindCredential: the API key is wrong or lacks permission. Stop sending.
	KindCredential
	// KindRetryable: a server error, a network failure or a concurrent
	// idempotent request. The same request may succeed later.
	KindRetryable
	// KindRateLimited: a 429 that persisted after the one retry.
	KindRateLimited
	// KindQuota: the account's sending quota is spent. Stop sending until it resets.
	KindQuota
)

// String names the kind for logs.
func (k Kind) String() string {
	switch k {
	case KindPermanent:
		return "permanent"
	case KindCredential:
		return "credential"
	case KindRetryable:
		return "retryable"
	case KindRateLimited:
		return "rate_limited"
	case KindQuota:
		return "quota"
	}
	return "unknown"
}

// SendError is a failed Send. Name is Resend's error name (for example
// "validation_error") or a transport marker such as "network", when it is set.
type SendError struct {
	Kind   Kind
	Status int
	Name   string
}

// Error implements error. It never includes the response body.
func (e *SendError) Error() string {
	if e.Status == 0 {
		return fmt.Sprintf("resend: %s (%s)", e.Kind, e.Name)
	}
	return fmt.Sprintf("resend: %s (status %d, %s)", e.Kind, e.Status, e.Name)
}

// Send posts one email under idempotencyKey and returns Resend's email id. An
// accepted send whose body has no id returns "" and no error: the email was
// accepted, and the idempotency key already prevents a duplicate.
//
// A 429 is retried once after its Retry-After (capped at five seconds). Every
// other failure returns at once, and the caller decides whether to retry.
func (c *Client) Send(ctx context.Context, e Email, idempotencyKey string) (string, error) {
	id, retryAfter, err := c.post(ctx, e, idempotencyKey)
	var se *SendError
	if err == nil || !errors.As(err, &se) || se.Kind != KindRateLimited {
		return id, err
	}
	wait := time.Second
	if retryAfter > 0 {
		wait = retryAfter
	}
	if wait > maxRetryAfter {
		wait = maxRetryAfter
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case <-timer.C:
	}
	id, _, err = c.post(ctx, e, idempotencyKey)
	return id, err
}

func (c *Client) post(ctx context.Context, e Email, idempotencyKey string) (string, time.Duration, error) {
	body, err := json.Marshal(e)
	if err != nil {
		return "", 0, &SendError{Kind: KindPermanent, Name: "encode"}
	}
	base := c.BaseURL
	if base == "" {
		base = DefaultBaseURL
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimSuffix(base, "/")+"/emails", bytes.NewReader(body))
	if err != nil {
		return "", 0, &SendError{Kind: KindPermanent, Name: "request"}
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", idempotencyKey)

	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", 0, &SendError{Kind: KindRetryable, Name: "network"}
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		var ok struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(raw, &ok)
		return ok.ID, 0, nil
	}
	return "", parseRetryAfter(resp.Header.Get("Retry-After")), classify(resp.StatusCode, errorName(raw))
}

// classify maps a non-2xx response to its SendError. The table is the contract
// the evaluator's delivery states are built on; TestClassify pins it.
func classify(status int, name string) *SendError {
	se := &SendError{Status: status, Name: name}
	switch {
	case status == http.StatusBadRequest, status == http.StatusUnprocessableEntity:
		se.Kind = KindPermanent
	case status == http.StatusUnauthorized, status == http.StatusForbidden:
		se.Kind = KindCredential
	case status == http.StatusConflict:
		if name == "concurrent_idempotent_requests" {
			se.Kind = KindRetryable
		} else {
			se.Kind = KindPermanent
		}
	case status == http.StatusTooManyRequests:
		if strings.HasSuffix(name, "quota_exceeded") {
			se.Kind = KindQuota
		} else {
			se.Kind = KindRateLimited
		}
	case status >= 500:
		se.Kind = KindRetryable
	default:
		se.Kind = KindPermanent
	}
	return se
}

// errorName extracts Resend's error name from an error body. It keeps the name
// only when it is a plain lower-case identifier, so a message can never leak
// into the result through it.
func errorName(raw []byte) string {
	var body struct {
		Name string `json:"name"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return ""
	}
	for _, r := range body.Name {
		if (r < 'a' || r > 'z') && r != '_' {
			return ""
		}
	}
	if len(body.Name) > 64 {
		return ""
	}
	return body.Name
}

// parseRetryAfter reads a Retry-After given in seconds. HTTP-date form is not
// used by Resend; anything else is zero, which Send treats as the default wait.
func parseRetryAfter(v string) time.Duration {
	secs, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || secs < 0 {
		return 0
	}
	return time.Duration(secs) * time.Second
}
