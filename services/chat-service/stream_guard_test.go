package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// waitDone reports whether ctx ends within limit.
func waitDone(ctx context.Context, limit time.Duration) bool {
	select {
	case <-ctx.Done():
		return true
	case <-time.After(limit):
		return false
	}
}

func TestStreamGuardFirstByteBoundCancelsSilentCall(t *testing.T) {
	g := newStreamGuard(context.Background(), streamTimeouts{FirstByte: 20 * time.Millisecond, Idle: time.Second})
	defer g.stop()
	if !waitDone(g.ctx, 2*time.Second) {
		t.Fatal("first-byte bound did not cancel a call that sent nothing")
	}
	if !g.expired() {
		t.Fatal("expired() = false after the first-byte bound fired")
	}
}

func TestStreamGuardTouchRestartsIdleBound(t *testing.T) {
	g := newStreamGuard(context.Background(), streamTimeouts{FirstByte: 100 * time.Millisecond, Idle: 100 * time.Millisecond})
	defer g.stop()
	// Chunks arrive every 40ms, well inside the 100ms bounds, for 300ms.
	for range 8 {
		time.Sleep(40 * time.Millisecond)
		g.touch()
	}
	if g.expired() || g.ctx.Err() != nil {
		t.Fatal("a call with a chunk every 40ms was cut off")
	}
}

func TestStreamGuardIdleBoundAfterLastChunk(t *testing.T) {
	g := newStreamGuard(context.Background(), streamTimeouts{FirstByte: time.Second, Idle: 30 * time.Millisecond})
	defer g.stop()
	g.touch()
	if !waitDone(g.ctx, 2*time.Second) {
		t.Fatal("idle bound did not cancel a call that went silent after a chunk")
	}
	if !g.expired() {
		t.Fatal("expired() = false after the idle bound fired")
	}
}

func TestStreamGuardCallerCancelIsNotExpiry(t *testing.T) {
	parent, cancel := context.WithCancel(context.Background())
	g := newStreamGuard(parent, defaultStreamTimeouts())
	defer g.stop()
	cancel()
	if !waitDone(g.ctx, time.Second) {
		t.Fatal("parent cancel did not reach the guard's context")
	}
	if g.expired() {
		t.Fatal("expired() = true for a caller cancel")
	}
}

// A Gemini endpoint that never answers must fail the call as a timeout that is
// not reached and not retried on the same provider: the turn goes to the fallback.
func TestGeminiSilentEndpointTimesOutWithoutASameProviderRetry(t *testing.T) {
	// gone closes when the server sees the client drop the request, so the test
	// can check that a timed-out call really lets go of its connection.
	// The handler drains the body first: an HTTP/1.1 server reports a client
	// disconnect only once the request body has been read.
	gone := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		<-r.Context().Done()
		close(gone)
	}))
	defer srv.Close()

	provider := newWireProvider(t, srv.URL)
	provider.timeouts = streamTimeouts{FirstByte: 50 * time.Millisecond, Idle: time.Second}
	session, err := provider.NewSession(SessionConfig{Model: wireModel, System: "s", Tools: chatToolDefinitions()})
	if err != nil {
		t.Fatalf("NewSession() error = %v", err)
	}
	_, err = session.Send(context.Background(), SendInput{UserText: "q"}, ToolChoiceRequired, func(ModelEvent) {})

	var pe *ProviderError
	if !errors.As(err, &pe) {
		t.Fatalf("Send() error = %v, want a *ProviderError", err)
	}
	if pe.Reached || pe.Retryable {
		t.Fatalf("ProviderError{Reached:%v Retryable:%v}, want a timeout before any chunk that is not retried", pe.Reached, pe.Retryable)
	}
	if !strings.Contains(err.Error(), "did not answer in time") {
		t.Fatalf("error %q does not name the timeout", err)
	}
	select {
	case <-gone:
	case <-time.After(5 * time.Second):
		t.Fatal("the server still sees the timed-out request open: the call did not close its connection")
	}
}
