package cronreporter

import (
	"context"
	"errors"
	"testing"
	"time"
)

// The sender advances the fake clock to model time spent waiting for HTTP.
// A zero-latency fake hid the old completion-relative cadence drift.
type heartbeatClockSender struct {
	now      *time.Time
	delay    time.Duration
	err      error
	attempts []time.Time
	accepted []time.Time
}

func (s *heartbeatClockSender) Send(_ context.Context, _ string, c checkin) error {
	if c.State != stateComplete {
		panic("heartbeat fixture received a job event")
	}
	at := *s.now
	s.attempts = append(s.attempts, at)
	*s.now = at.Add(s.delay)
	if s.err != nil {
		return s.err
	}
	s.accepted = append(s.accepted, at)
	return nil
}

func cadenceReporter(now *time.Time, s sender) (*reporter, *fakeCluster) {
	k := &fakeCluster{}
	r := newReporter(k, s, staticURLs(map[string]string{heartbeatKey: "https://example.invalid/heartbeat"}), config{
		interval: 30 * time.Second, heartbeatInterval: 5 * time.Minute,
	})
	r.now = func() time.Time { return *now }
	return r, k
}

func TestHeartbeatCadenceDoesNotAccumulateHTTPLatency(t *testing.T) {
	start := t0.Add(19 * time.Second)
	now := start
	s := &heartbeatClockSender{now: &now, delay: time.Millisecond}
	r, _ := cadenceReporter(&now, s)
	for tick := 0; tick < 8*60*2; tick++ {
		now = start.Add(time.Duration(tick) * 30 * time.Second)
		r.tick(context.Background())
	}
	if len(s.accepted) != 96 {
		t.Fatalf("8h of healthy reconciles: got %d heartbeats, want 96", len(s.accepted))
	}
	for i, at := range s.accepted {
		want := start.Add(time.Duration(i) * 5 * time.Minute)
		if !at.Equal(want) {
			t.Fatalf("heartbeat %d drifted to %s, want %s", i, at, want)
		}
	}
}

func TestHeartbeatCadenceBoundsPollJitterInsteadOfAccumulatingIt(t *testing.T) {
	start := t0.Add(19 * time.Second)
	now := start
	s := &heartbeatClockSender{now: &now, delay: 1500 * time.Millisecond}
	r, _ := cadenceReporter(&now, s)
	for tick := 0; tick < 8*60*2; tick++ {
		// Non-monotonic jitter around the fixed 30s polling schedule.
		jitter := time.Duration((tick*7)%11) * time.Second
		now = start.Add(time.Duration(tick)*30*time.Second + jitter)
		r.tick(context.Background())
	}
	if len(s.accepted) != 96 {
		t.Fatalf("got %d heartbeats, want 96", len(s.accepted))
	}
	for i, at := range s.accepted {
		late := at.Sub(start.Add(time.Duration(i) * 5 * time.Minute))
		if late < 0 || late > 10*time.Second {
			t.Fatalf("heartbeat %d accumulated jitter: %s", i, late)
		}
	}
}

func TestHeartbeatCadenceFailureDoesNotMoveDeadline(t *testing.T) {
	now := t0
	s := &heartbeatClockSender{now: &now, delay: time.Second}
	r, _ := cadenceReporter(&now, s)
	r.tick(context.Background())
	now = t0.Add(5 * time.Minute)
	s.err = errors.New("HTTP unavailable")
	r.tick(context.Background())
	if len(s.accepted) != 1 {
		t.Fatal("failed request was counted as a successful heartbeat")
	}
	now = t0.Add(5*time.Minute + 30*time.Second)
	s.err = nil
	r.tick(context.Background())
	now = t0.Add(10 * time.Minute)
	r.tick(context.Background())
	if len(s.accepted) != 3 || !s.accepted[2].Equal(now.Add(-time.Second)) {
		t.Fatalf("retry must preserve the 10-minute deadline; got %v", s.accepted)
	}
}

func TestHeartbeatCadenceReconcileOutageStaysSilentAndDoesNotReplay(t *testing.T) {
	now := t0
	s := &heartbeatClockSender{now: &now, delay: time.Millisecond}
	r, k := cadenceReporter(&now, s)
	r.tick(context.Background())
	k.listErr = errors.New("apiserver unavailable")
	for minute := 1; minute <= 19; minute++ {
		now = t0.Add(time.Duration(minute) * time.Minute)
		r.tick(context.Background())
	}
	if len(s.attempts) != 1 {
		t.Fatal("reporter must not heartbeat through failed reconciliations")
	}
	k.listErr = nil
	now = t0.Add(20*time.Minute + 10*time.Second)
	r.tick(context.Background())
	for i := 0; i < 5; i++ {
		r.tick(context.Background())
	}
	if len(s.accepted) != 2 {
		t.Fatalf("outage recovery replayed old heartbeats: %v", s.accepted)
	}
	now = t0.Add(25 * time.Minute)
	r.tick(context.Background())
	if len(s.accepted) != 3 {
		t.Fatal("recovery rebased the original cadence")
	}
}

func TestHeartbeatCadenceLongSendSkipsElapsedDeadlines(t *testing.T) {
	now := t0
	s := &heartbeatClockSender{now: &now, delay: 12 * time.Minute}
	r, _ := cadenceReporter(&now, s)
	r.tick(context.Background())
	s.delay = 0
	r.tick(context.Background())
	if len(s.accepted) != 1 {
		t.Fatal("long send caused a catch-up burst")
	}
	now = t0.Add(15 * time.Minute)
	r.tick(context.Background())
	if len(s.accepted) != 2 {
		t.Fatalf("want next original deadline at 15 minutes, got %v", s.accepted)
	}
}

func TestHeartbeatCadenceStartupAndRestartRemainImmediate(t *testing.T) {
	// This intentionally preserves old startup semantics. It is not evidence
	// that the receiver deduplicates separate reporter processes or lost replies.
	now := t0.Add(4*time.Minute + 55*time.Second)
	s := &heartbeatClockSender{now: &now, delay: time.Second}
	r, _ := cadenceReporter(&now, s)
	r.tick(context.Background())
	restarted, _ := cadenceReporter(&now, s)
	restarted.tick(context.Background())
	if len(s.accepted) != 2 {
		t.Fatalf("startup/restart behavior changed: %v", s.accepted)
	}
}

func TestHeartbeatCadenceDoesNotReplayOnBackwardClock(t *testing.T) {
	now := t0
	s := &heartbeatClockSender{now: &now}
	r, _ := cadenceReporter(&now, s)
	r.tick(context.Background())
	now = t0.Add(-time.Minute)
	r.tick(context.Background())
	now = t0.Add(5 * time.Minute)
	r.tick(context.Background())
	if len(s.accepted) != 2 {
		t.Fatalf("unexpected heartbeats across backward clock: %v", s.accepted)
	}
}

func TestHeartbeatCadenceDisabledPathsNeverSend(t *testing.T) {
	for _, dry := range []bool{false, true} {
		now := t0
		s := &heartbeatClockSender{now: &now}
		r, _ := cadenceReporter(&now, s)
		r.cfg.dryRun = dry
		if !dry {
			r.urls = staticURLs(nil)
		}
		r.tick(context.Background())
		if len(s.attempts) != 0 {
			t.Fatalf("disabled heartbeat sent (dry=%v)", dry)
		}
	}
}
