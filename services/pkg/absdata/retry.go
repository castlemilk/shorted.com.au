package absdata

import (
	"context"
	"io"
	"math/rand"
	"net/http"
	"time"
)

// Retry policy for every ABS/RBA/DCCEEW fetch.
//
// These endpoints sit behind WAFs and publish on release days, so the failures
// worth retrying are transport blips, throttling and origin 5xx — all
// transient. Everything else 4xx is NOT: a 404 is upstream drift (a dataflow
// or table that moved) and a 403 is the WAF rejecting our headers. Both are
// real, actionable faults that must fail fast and loudly rather than be
// hammered three times and reported minutes later.
const (
	defaultAttempts = 3
	defaultBackoff  = 500 * time.Millisecond
	// Cap on the body drained from a response we are discarding, so the
	// connection returns to the keep-alive pool without reading a whole CSV.
	drainLimit = 64 << 10
)

// GetWithRetry GETs url through hc with the retry policy above, applying header
// to every attempt (the mandatory User-Agent must survive a retry).
//
// It returns the LAST response even when that response is an unretryable or
// exhausted failure, so callers keep their own status/body error wording.
// Requests carry no body, so each attempt simply rebuilds the request.
func GetWithRetry(ctx context.Context, hc *http.Client, url string, header http.Header) (*http.Response, error) {
	return getWithRetry(ctx, hc, url, header, defaultAttempts, defaultBackoff)
}

func getWithRetry(
	ctx context.Context,
	hc *http.Client,
	url string,
	header http.Header,
	attempts int,
	backoff time.Duration,
) (*http.Response, error) {
	if attempts < 1 {
		attempts = defaultAttempts
	}
	if backoff <= 0 {
		backoff = defaultBackoff
	}

	for attempt := 1; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return nil, err
		}
		for name, values := range header {
			for _, v := range values {
				req.Header.Add(name, v)
			}
		}

		resp, err := hc.Do(req)
		if attempt == attempts || !retryable(ctx, resp, err) {
			return resp, err
		}

		// The retried body is never read; draining and closing it keeps the
		// connection reusable instead of leaking it.
		if resp != nil {
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, drainLimit))
			_ = resp.Body.Close()
		}
		if err := sleepBackoff(ctx, attempt, backoff); err != nil {
			return nil, err
		}
	}
}

// retryable reports whether the outcome is transient. A cancelled or expired
// context is never transient — the caller has already decided to stop.
func retryable(ctx context.Context, resp *http.Response, err error) bool {
	if ctx.Err() != nil {
		return false
	}
	if err != nil {
		return true // transport error: DNS, connection reset, client timeout
	}
	return resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500
}

// sleepBackoff waits base*2^(attempt-1) plus up to 50% jitter, so a run that
// retries several sources at once does not resynchronise them onto the same
// upstream. Returns ctx.Err() if the wait is cut short.
func sleepBackoff(ctx context.Context, attempt int, base time.Duration) error {
	delay := base << (attempt - 1)
	delay += time.Duration(rand.Int63n(int64(delay/2) + 1))

	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
