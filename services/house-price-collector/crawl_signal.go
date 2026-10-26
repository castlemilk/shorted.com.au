package main

import (
	"context"
	"log"
	"math/rand"
	"os"
	"sync"
	"time"
)

// exitCrawlCancelled is the `-mode agent` exit code for a round that was stopped
// early on purpose: a SIGTERM/SIGINT, an events stream that closed (the parent
// died), or an orphaned process. The round finishes its current suburb, runs the
// normal finalize, and exits with this code. The drain wrapper treats it as an
// unknown rc and stops, which is the intent.
const exitCrawlCancelled = 10

// stopSignal is the one-way "stop claiming" latch. The first reason wins, and the
// latch closes its channel so an idle wait can end promptly.
type stopSignal struct {
	mu     sync.Mutex
	reason string
	ch     chan struct{}
}

func newStopSignal() *stopSignal {
	return &stopSignal{ch: make(chan struct{})}
}

// request latches the stop. It is idempotent and keeps the first reason.
func (s *stopSignal) request(reason string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.reason != "" {
		return
	}
	s.reason = reason
	close(s.ch)
}

// Reason returns the latched reason, or "" when no stop has been requested.
func (s *stopSignal) Reason() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reason
}

// Done is closed when a stop is requested.
func (s *stopSignal) Done() <-chan struct{} {
	return s.ch
}

// watchSignals turns OS signals into the stop latch. The first signal requests a
// graceful stop: the round finishes its current suburb and finalizes. A second
// signal calls exit(exitCrawlCancelled) at once. The loop returns when done closes.
// sigs and exit are injected so tests can drive them directly.
func watchSignals(sigs <-chan os.Signal, done <-chan struct{}, stop *stopSignal, exit func(int)) {
	seen := 0
	for {
		select {
		case <-done:
			return
		case sig := <-sigs:
			seen++
			if seen == 1 {
				stop.request("signal")
				log.Printf("[agent] %v: stop claiming — finishing the current suburb, then finalizing (exit %d)", sig, exitCrawlCancelled)
				continue
			}
			log.Printf("[agent] second %v: exiting now (exit %d), skipping finalize", sig, exitCrawlCancelled)
			exit(exitCrawlCancelled)
			return
		}
	}
}

// jitterSleepUntil is jitterSleep (crawl_listings.go) with one extra exit: a stop
// request ends the pause, so a signal that arrives between suburbs is acted on
// promptly and not after the full jitter.
func jitterSleepUntil(ctx context.Context, stopped <-chan struct{}, lo, hi time.Duration) {
	d := lo
	if hi > lo {
		d += time.Duration(rand.Int63n(int64(hi - lo)))
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
	case <-stopped:
	case <-ctx.Done():
	}
}
