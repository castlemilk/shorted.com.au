package shorts

import (
	"context"
	"net"
	"net/http"
	"testing"
	"time"
)

// Serve must return when its context ends: main's s.Close() (the monthly
// quota flush) runs only after it does. It used to be a bare ListenAndServe
// that ignored the context, so SIGTERM left the process listening.
func TestServeUntilDone_ReturnsWhenContextEnds(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- serveUntilDone(ctx, srv, ln, time.Second) }()

	resp, err := http.Get("http://" + ln.Addr().String())
	if err != nil {
		t.Fatalf("server not serving: %v", err)
	}
	_ = resp.Body.Close()

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("a requested shutdown must return nil, got %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("serveUntilDone ignored its context")
	}
	if c, err := net.DialTimeout("tcp", ln.Addr().String(), 200*time.Millisecond); err == nil {
		_ = c.Close()
		t.Fatal("still listening after shutdown")
	}
}

// A request still running at the deadline must not hold shutdown open past it.
func TestServeUntilDone_BoundsTheDrain(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	defer close(release)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		select {
		case <-release:
		case <-r.Context().Done():
		}
	})}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- serveUntilDone(ctx, srv, ln, 200*time.Millisecond) }()
	go func() {
		if resp, err := http.Get("http://" + ln.Addr().String()); err == nil {
			_ = resp.Body.Close()
		}
	}()
	<-started

	t0 := time.Now()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("a drain that hits its deadline is still a requested shutdown, got %v", err)
		}
		if d := time.Since(t0); d > 2*time.Second {
			t.Fatalf("drain took %v, want about the 200ms grace", d)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("a long request held shutdown past the grace")
	}
}

// Cloud Run kills the container 10s after SIGTERM; the drain must leave room
// for the quota flush that follows it.
func TestShutdownGraceLeavesRoomForTheFlush(t *testing.T) {
	if ShutdownGrace <= 0 || ShutdownGrace >= 10*time.Second {
		t.Fatalf("ShutdownGrace %v must sit inside Cloud Run's 10s SIGTERM window", ShutdownGrace)
	}
}
