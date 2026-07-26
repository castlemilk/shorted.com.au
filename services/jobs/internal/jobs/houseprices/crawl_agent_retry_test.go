package houseprices

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// TestBrandbrainClient_RetriesTransient proves the queue client retries a
// transient 5xx (the brandbrain-502-at->2-workers case) and a network blip
// rather than losing the call — the fix for the observed "TLS handshake timeout"
// dropping a completed suburb's counts.
func TestBrandbrainClient_RetriesTransient(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if atomic.AddInt32(&calls, 1) < 3 {
			w.WriteHeader(http.StatusBadGateway) // 502 twice
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	c := &brandbrainAgentClient{url: srv.URL, http: &http.Client{Timeout: 5 * time.Second}}
	if err := c.do(context.Background(), http.MethodPost, "/x", nil, nil); err != nil {
		t.Fatalf("expected success after retrying past the 502s, got %v", err)
	}
	if n := atomic.LoadInt32(&calls); n != 3 {
		t.Fatalf("expected 3 attempts (2 x 502 + 1 x 200), got %d", n)
	}
}

// TestBrandbrainClient_NoRetryOn4xx proves a terminal client error (4xx that
// isn't a refreshable 401) is NOT retried — retrying a bad request is pointless
// and would mask the real error.
func TestBrandbrainClient_NoRetryOn4xx(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusBadRequest) // 400
	}))
	defer srv.Close()

	c := &brandbrainAgentClient{url: srv.URL, http: &http.Client{Timeout: 5 * time.Second}}
	if err := c.do(context.Background(), http.MethodPost, "/x", nil, nil); err == nil {
		t.Fatal("expected an error on a 400")
	}
	if n := atomic.LoadInt32(&calls); n != 1 {
		t.Fatalf("a 4xx must not be retried, got %d attempts", n)
	}
}
