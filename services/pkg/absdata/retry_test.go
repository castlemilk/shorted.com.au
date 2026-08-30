package absdata

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestGetWithRetryRecoversFromTransient(t *testing.T) {
	for _, status := range []int{http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusBadGateway} {
		var calls atomic.Int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if calls.Add(1) == 1 {
				w.WriteHeader(status)
				return
			}
			// The mandatory WAF header must survive the retry, or the second
			// attempt is rejected for a different reason than the first.
			if r.Header.Get("User-Agent") != UserAgent {
				t.Errorf("retry lost the User-Agent: %q", r.Header.Get("User-Agent"))
			}
			w.WriteHeader(http.StatusOK)
		}))
		defer srv.Close()

		resp, err := getWithRetry(context.Background(), srv.Client(), srv.URL,
			http.Header{"User-Agent": {UserAgent}}, defaultAttempts, time.Millisecond)
		if err != nil {
			t.Fatalf("HTTP %d: %v", status, err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("HTTP %d: final status = %d, want 200", status, resp.StatusCode)
		}
		if got := calls.Load(); got != 2 {
			t.Errorf("HTTP %d: attempts = %d, want 2", status, got)
		}
	}
}

// A 404 is upstream drift (a dataflow that moved) and a 403 is the WAF
// rejecting our headers. Both are real, actionable faults: retrying only delays
// the report.
func TestGetWithRetryNeverRetriesOtherClientErrors(t *testing.T) {
	for _, status := range []int{http.StatusNotFound, http.StatusForbidden, http.StatusBadRequest} {
		var calls atomic.Int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			calls.Add(1)
			w.WriteHeader(status)
		}))
		defer srv.Close()

		resp, err := getWithRetry(context.Background(), srv.Client(), srv.URL, nil, defaultAttempts, time.Millisecond)
		if err != nil {
			t.Fatalf("HTTP %d: %v", status, err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != status {
			t.Errorf("status = %d, want %d passed through untouched", resp.StatusCode, status)
		}
		if got := calls.Load(); got != 1 {
			t.Errorf("HTTP %d: attempts = %d, want 1 (no retry)", status, got)
		}
	}
}

// Exhausting the attempts returns the LAST response, so the caller's own
// "HTTP %d: %s" wording still carries the upstream status and body excerpt.
func TestGetWithRetryReturnsLastResponseAfterExhaustion(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	resp, err := getWithRetry(context.Background(), srv.Client(), srv.URL, nil, 3, time.Millisecond)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", resp.StatusCode)
	}
	if got := calls.Load(); got != 3 {
		t.Errorf("attempts = %d, want 3", got)
	}
}

// A cancelled context stops the retry loop: the caller (SIGTERM, or the job's
// own ECONOMY_TIMEOUT_MIN ceiling) has already decided to stop, and a retry
// would spend the shutdown window on a request that cannot complete.
func TestGetWithRetryHonoursContextCancellation(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	t.Run("already cancelled makes no request", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		before := calls.Load()
		resp, err := getWithRetry(ctx, srv.Client(), srv.URL, nil, defaultAttempts, time.Millisecond)
		if resp != nil {
			_ = resp.Body.Close()
		}
		if err == nil {
			t.Fatal("want the context error")
		}
		if got := calls.Load() - before; got != 0 {
			t.Errorf("requests = %d, want 0", got)
		}
	})

	t.Run("expiring during backoff aborts the wait", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
		defer cancel()
		before := calls.Load()
		// Backoff far exceeds the deadline: the loop must return the context
		// error rather than sleep through it.
		resp, err := getWithRetry(ctx, srv.Client(), srv.URL, nil, defaultAttempts, 5*time.Second)
		if resp != nil {
			_ = resp.Body.Close()
		}
		if err == nil {
			t.Fatal("want the context error")
		}
		if got := calls.Load() - before; got != 1 {
			t.Errorf("requests = %d, want 1", got)
		}
	})
}

func TestRetryPolicyDefaultsApplyToEveryClient(t *testing.T) {
	c := NewClient()
	if c.attempts != defaultAttempts || c.backoff != defaultBackoff {
		t.Fatalf("NewClient retry policy = %d attempts / %v backoff", c.attempts, c.backoff)
	}

	// A zero-valued Client (built by anything other than NewClient) must still
	// retry rather than silently fall back to a single shot.
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	resp, err := getWithRetry(context.Background(), srv.Client(), srv.URL, nil, 0, time.Millisecond)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	_ = resp.Body.Close()
	if got := calls.Load(); got != defaultAttempts {
		t.Errorf("attempts with a zero policy = %d, want %d", got, defaultAttempts)
	}
}
