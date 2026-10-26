package main

import (
	"context"
	"errors"
	"sync"
	"time"
)

// Per-call bounds on a streamed model call. The first data chunk must arrive
// within the first-byte bound, and each later one within the idle bound. SSE
// comment lines and blank lines are not data: a provider that keeps a queued
// request open with keep-alive comments must still time out.
const (
	defaultFirstByteTimeout = 15 * time.Second
	defaultIdleTimeout      = 20 * time.Second
)

// streamTimeouts holds the two bounds of one provider.
type streamTimeouts struct {
	FirstByte time.Duration
	Idle      time.Duration
}

// errTimedOut is the error a bound reports. It names no URL and no key.
var errTimedOut = errors.New("the model did not answer in time")

func defaultStreamTimeouts() streamTimeouts {
	return streamTimeouts{FirstByte: defaultFirstByteTimeout, Idle: defaultIdleTimeout}
}

// streamGuard cancels a model call's context when a bound expires. The caller
// reads from guard.ctx; after an error it asks expired whether the cancel was
// the guard's doing or the caller's.
type streamGuard struct {
	ctx    context.Context
	cancel context.CancelFunc
	idle   time.Duration

	mu    sync.Mutex
	timer *time.Timer
	fired bool
}

// newStreamGuard starts the first-byte bound at once, so it also covers the
// request and the response headers.
func newStreamGuard(parent context.Context, t streamTimeouts) *streamGuard {
	ctx, cancel := context.WithCancel(parent)
	g := &streamGuard{ctx: ctx, cancel: cancel, idle: t.Idle}
	g.timer = time.AfterFunc(t.FirstByte, g.fire)
	return g
}

func (g *streamGuard) fire() {
	g.mu.Lock()
	g.fired = true
	g.mu.Unlock()
	g.cancel()
}

// touch records a data chunk and restarts the idle bound.
func (g *streamGuard) touch() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.fired {
		return
	}
	g.timer.Reset(g.idle)
}

// expired reports whether a bound, rather than the caller, cancelled the call.
func (g *streamGuard) expired() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.fired
}

// stop releases the timer and the context once the call has ended.
func (g *streamGuard) stop() {
	g.mu.Lock()
	g.timer.Stop()
	g.mu.Unlock()
	g.cancel()
}
