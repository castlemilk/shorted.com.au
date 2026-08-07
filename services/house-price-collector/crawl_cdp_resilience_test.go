package main

import (
	"context"
	"strings"
	"testing"
	"time"
)

// TestCDPFetch_NilContextDoesNotPanic is the regression for the prod SIGSEGV.
//
// reconnectLocked nils f.ctx BEFORE rebuilding, so a reconnect that itself fails
// leaves the fetcher holding a nil context. Every later fetch then dereferenced it
// inside fetchInContext and killed the whole collector:
//
//	runtime error: invalid memory address or nil pointer dereference
//	main.fetchInContext(..., {0x0, 0x0}, ...)
//
// A dead CDP link must degrade to an error, never a crash: one unreachable Chrome
// should cost the run, not the process.
func TestCDPFetch_NilContextDoesNotPanic(t *testing.T) {
	// Port 1 is reserved and never listening, so the internal reconnect is
	// guaranteed to fail — exactly the state that used to panic.
	f := &cdpFetcher{cfg: crawlConfig{cdpURL: "http://127.0.0.1:1", fetchTimeout: time.Second}}

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("fetch with a nil browser context must not panic, got: %v", r)
		}
	}()

	_, _, err := f.fetch(context.Background(), "https://example.com/")
	if err == nil {
		t.Fatalf("expected a clean error when there is no browser context and reconnect fails")
	}
	if !strings.Contains(err.Error(), "no browser context") {
		t.Fatalf("error should name the nil-context cause, got: %v", err)
	}
}

// TestCDPStalledIsTreatedAsConnLost keeps the watchdog wired to recovery. The
// watchdog error only helps if isCDPConnLost matches it, because tearing the
// driver down via pw.Stop() on the reconnect path is what actually releases a
// wedged call.
func TestCDPStalledIsTreatedAsConnLost(t *testing.T) {
	if !isCDPConnLost(errCDPStalled) {
		t.Fatalf("errCDPStalled must be recognised as a lost connection so the reconnect path runs; message was %q", errCDPStalled)
	}
}

// TestCDPWatchdog_Bounds covers the wall-clock ceiling that a ctx deadline cannot
// provide. playwright-go blocks on its driver pipe without observing ctx, which is
// how `-mode agent` reached 13h02m elapsed with CRAWL_TIMEOUT_MIN set to 4h.
func TestCDPWatchdog_Bounds(t *testing.T) {
	t.Setenv("CRAWL_CDP_WATCHDOG_S", "")
	f := &cdpFetcher{cfg: crawlConfig{fetchTimeout: 60 * time.Second}}
	if got := f.watchdog(); got != 3*time.Minute {
		t.Errorf("watchdog should default to 3x the fetch timeout, got %s", got)
	}

	// Never zero: a zero timer would fire instantly and fail every fetch.
	bare := &cdpFetcher{cfg: crawlConfig{}}
	if got := bare.watchdog(); got <= 0 {
		t.Errorf("watchdog must never be zero or negative, got %s", got)
	}

	t.Setenv("CRAWL_CDP_WATCHDOG_S", "45")
	if got := f.watchdog(); got != 45*time.Second {
		t.Errorf("CRAWL_CDP_WATCHDOG_S must override, got %s", got)
	}
}

// TestCDPFetchGuarded_NilContextIsAnErrorNotAPanic covers the detached-goroutine
// hazard. fetchGuarded's worker is ABANDONED when the watchdog fires, so it
// outlives its caller and no recover() upstream can ever catch it — an unrecovered
// panic there would kill the collector from a goroutine whose stack points away
// from the real cause. A nil context must be rejected before we ever spawn it.
func TestCDPFetchGuarded_NilContextIsAnErrorNotAPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("fetchGuarded must not panic on a nil context, got: %v", r)
		}
	}()
	f := &cdpFetcher{cfg: crawlConfig{fetchTimeout: time.Second}}
	if _, _, err := f.fetchGuarded(context.Background(), "https://example.com/"); err == nil {
		t.Fatalf("expected an error for a nil browser context")
	} else if !isCDPConnLost(err) {
		t.Fatalf("a nil-context error must be recoverable via the reconnect path, got: %v", err)
	}
}
