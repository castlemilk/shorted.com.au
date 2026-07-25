package signals

import (
	"bytes"
	"context"
	"crypto/sha1" //nolint:gosec // content_hash is a dedupe key, not a security primitive; the schema (000052) pins sha1.
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
)

// defaultBrandbrainURL is collect.py's BRANDBRAIN_URL default; the deployed job
// overrides it with the same env var.
const defaultBrandbrainURL = "https://api.brandbrain.dev/brandbrain.v1.DiscoveryService/ResolveBusinessSignals"

// resolveTimeout matches collect.py's per-request timeout: these are grounded
// Gemini research calls and are genuinely slow.
const resolveTimeout = 180 * time.Second

// resolveRetries matches collect.py's retries=3 default.
const resolveRetries = 3

// signal is one adverse/positive finding from brandbrain.
type signal struct {
	Headline   string          `json:"headline"`
	Kind       *string         `json:"kind"`
	Detail     *string         `json:"detail"`
	Date       *string         `json:"date"`
	Severity   *string         `json:"severity"`
	Citations  json.RawMessage `json:"citations"`
	Confidence *float64        `json:"confidence"`
}

// signalsPayload is the ResolveBusinessSignals response envelope. Only the two
// signal lists are consumed; everything else brandbrain returns is ignored.
type signalsPayload struct {
	Adverse  []signal `json:"adverse"`
	Positive []signal `json:"positive"`
}

// signalRow is one stock_signals row, in insert order.
type signalRow struct {
	StockCode   string
	Polarity    string
	Kind        *string
	Headline    string
	Detail      *string
	EventDate   *string
	Severity    *string
	Citations   string // JSON array text, cast to jsonb at insert time
	Confidence  float64
	ContentHash string
}

// brandbrainClient calls ResolveBusinessSignals with collect.py's retry policy.
type brandbrainClient struct {
	url     string
	http    *http.Client
	retries int
}

func newBrandbrainClient() *brandbrainClient {
	return &brandbrainClient{
		url:     platform.GetEnv("BRANDBRAIN_URL", defaultBrandbrainURL),
		http:    &http.Client{Timeout: resolveTimeout},
		retries: resolveRetries,
	}
}

// Resolve calls brandbrain for one company name.
//
// brandbrain runs on a single instance and 502s under concurrency, so transient
// 5xx are retried with the same 1s/3s backoff collect.py used. Non-5xx statuses
// are terminal. Unlike collect.py (which returned None and logged a warning),
// failures are returned as errors — the caller logs and counts them, which
// keeps the "one stock failed" behaviour without swallowing the reason.
func (c *brandbrainClient) Resolve(ctx context.Context, companyName string) (*signalsPayload, error) {
	body, err := json.Marshal(map[string]string{"business_name": companyName, "state": ""})
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	var lastErr error
	for attempt := 0; attempt < c.retries; attempt++ {
		if attempt > 0 {
			// 1s, 3s — collect.py's 2**attempt + attempt, indexed off the
			// FAILED attempt (0 → 1s, 1 → 3s).
			if err := sleepCtx(ctx, backoff(attempt-1)); err != nil {
				return nil, err
			}
		}
		payload, retryable, err := c.resolveOnce(ctx, body)
		if err == nil {
			return payload, nil
		}
		lastErr = err
		if !retryable || ctx.Err() != nil {
			return nil, err
		}
	}
	return nil, fmt.Errorf("brandbrain call failed after %d attempts: %w", c.retries, lastErr)
}

// resolveOnce performs a single request. retryable reports whether another
// attempt could plausibly succeed (transport error or 5xx).
func (c *brandbrainClient) resolveOnce(ctx context.Context, body []byte) (payload *signalsPayload, retryable bool, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return nil, false, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, true, fmt.Errorf("brandbrain request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
		retryable = resp.StatusCode >= 500 && resp.StatusCode < 600
		return nil, retryable, fmt.Errorf("brandbrain HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(snippet)))
	}

	var out signalsPayload
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, false, fmt.Errorf("decode brandbrain response: %w", err)
	}
	return &out, false, nil
}

// backoff is collect.py's 2**n + n sleep schedule.
func backoff(n int) time.Duration {
	return time.Duration((1<<uint(n))+n) * time.Second
}

// sleepCtx waits for d, or returns early when the context is cancelled — a
// batch job must not sit in an uninterruptible sleep after SIGTERM.
func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// contentHash is collect.py's _hash: sha1("code|polarity|headline"). It is the
// dedupe key behind the stock_signals (stock_code, content_hash) unique index,
// so the input string and algorithm are a stored-data contract.
func contentHash(stockCode, polarity, headline string) string {
	sum := sha1.Sum([]byte(stockCode + "|" + polarity + "|" + headline)) //nolint:gosec // see import comment
	return hex.EncodeToString(sum[:])
}

// rowsFromSignals maps a brandbrain payload to stock_signals rows, adverse
// first then positive (collect.py's _rows_from_signals order). Signals with a
// blank headline are dropped — headline is NOT NULL and part of the hash.
func rowsFromSignals(stockCode string, payload *signalsPayload) []signalRow {
	if payload == nil {
		return nil
	}
	var rows []signalRow
	for _, group := range []struct {
		polarity string
		signals  []signal
	}{
		{"adverse", payload.Adverse},
		{"positive", payload.Positive},
	} {
		for _, s := range group.signals {
			headline := strings.TrimSpace(s.Headline)
			if headline == "" {
				continue
			}
			confidence := 0.0
			if s.Confidence != nil {
				confidence = *s.Confidence
			}
			rows = append(rows, signalRow{
				StockCode:   stockCode,
				Polarity:    group.polarity,
				Kind:        s.Kind,
				Headline:    headline,
				Detail:      s.Detail,
				EventDate:   s.Date,
				Severity:    s.Severity,
				Citations:   citationsJSON(s.Citations),
				Confidence:  confidence,
				ContentHash: contentHash(stockCode, group.polarity, headline),
			})
		}
	}
	return rows
}

// citationsJSON normalises the citations blob to a JSON array literal —
// missing/null becomes "[]", matching collect.py's `or []` and the column's
// NOT NULL DEFAULT '[]'.
func citationsJSON(raw json.RawMessage) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return "[]"
	}
	return trimmed
}

func countPolarities(rows []signalRow) (adverse, positive int) {
	for _, r := range rows {
		if r.Polarity == "adverse" {
			adverse++
		} else {
			positive++
		}
	}
	return adverse, positive
}
