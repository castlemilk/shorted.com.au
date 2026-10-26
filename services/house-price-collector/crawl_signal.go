package main

import (
	"context"
	"log"
	"math/rand"
	"os"
	"os/signal"
	"sync"
	"syscall"
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

// startParentPID is the parent PID at process start. It is captured in a package
// variable initialiser, before the lock and the Chrome warm-up, so a later
// reparent to launchd (PPID 1) is detected against the real starting parent.
var startParentPID = os.Getppid()

// installRoundSignals is the signal setup for one `-mode agent` round:
//   - SIGPIPE is ignored. A process-group signal can kill `| tee` first, and then
//     the next log write would SIGPIPE-kill the collector before it finishes or
//     finalizes. Ignored, a write to a dead pipe returns EPIPE and the round
//     carries on, or stops claiming on the events fd (see crawl_events.go).
//   - SIGTERM/SIGINT feed watchSignals: the first requests a graceful stop, the
//     second exits through forceExit.
//
// The returned func undoes the Notify and ends the watcher. sigs and exit are
// injected so the tests can drive the whole path.
func installRoundSignals(stop *stopSignal, lock *crawlLock, sigs chan os.Signal, exit func(int)) (remove func()) {
	signal.Ignore(syscall.SIGPIPE)
	signal.Notify(sigs, syscall.SIGTERM, os.Interrupt)
	done := make(chan struct{})
	go watchSignals(sigs, done, stop, forceExit(lock, exit))
	return func() {
		signal.Stop(sigs)
		close(done)
	}
}

// forceExit is the second-signal exit. It releases the lock BEFORE exiting, so an
// immediate exit does not leave a stale lock for the next run to reclaim. A nil
// lock (tests) skips the release.
func forceExit(lock *crawlLock, exit func(int)) func(int) {
	return func(code int) {
		if lock != nil {
			lock.release()
		}
		exit(code)
	}
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
