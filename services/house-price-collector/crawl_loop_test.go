package main

import (
	"bytes"
	"context"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// syncBuffer is a bytes.Buffer safe to read while the loop writes to it.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// failWriter stands in for an events fd whose reader has gone away.
type failWriter struct{ err error }

func (f failWriter) Write([]byte) (int, error) { return 0, f.err }

// fakeQueue is a scripted brandbrain queue plus a per-job runner. A job whose
// Source is "fail" comes back as a blocked, failed sweep. Every other job succeeds.
type fakeQueue struct {
	mu       sync.Mutex
	queue    []*agentCrawlJob
	claims   int
	runs     int
	submits  []string
	onClaim  func(n int)
	runDelay func(job *agentCrawlJob)
}

func (q *fakeQueue) claim(ctx context.Context) (*agentCrawlJob, error) {
	q.mu.Lock()
	q.claims++
	n := q.claims
	hook := q.onClaim
	q.mu.Unlock()
	if hook != nil {
		hook(n)
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.queue) == 0 {
		return nil, nil
	}
	j := q.queue[0]
	q.queue = q.queue[1:]
	return j, nil
}

func (q *fakeQueue) runJob(ctx context.Context, job *agentCrawlJob) (crawlJobSummary, string, string, bool, time.Duration) {
	q.mu.Lock()
	q.runs++
	delay := q.runDelay
	q.mu.Unlock()
	if delay != nil {
		delay(job)
	}
	if job.Source == "fail" {
		return crawlJobSummary{Suburbs: 1, Listings: 1, BlockedSweeps: 1, Detail: "blocked at Hinchinbrook Heights https://example.test/x"}, "failed", "blocked", false, 0
	}
	return crawlJobSummary{Suburbs: 1, Listings: 4, Events: 2, Detail: "ok"}, "succeeded", "", true, 0
}

func (q *fakeQueue) submit(_ context.Context, jobID, status string, _ *crawlJobSummary, _ string, _ time.Duration) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.submits = append(q.submits, jobID+":"+status)
	return nil
}

func (q *fakeQueue) round(maxJobs int, ev *crawlEvents, stop *stopSignal) roundIO {
	return roundIO{
		maxJobs: maxJobs,
		claim:   q.claim,
		allOpen: func() (bool, time.Duration) { return false, 0 },
		runJob:  q.runJob,
		submit:  q.submit,
		pause:   func(context.Context, <-chan struct{}) {},
		blocks:  newBlockTracker(2),
		events:  ev,
		stop:    stop,
		ppid:    func() int { return 4242 },
	}
}

func suburbJob(id, suburb, source string) *agentCrawlJob {
	return &agentCrawlJob{ID: id, Kind: "housing", Suburb: suburb, State: "NSW", Postcode: "2000", Source: source, Tier: "listings"}
}

// eventNames returns the event kind of each NDJSON line, in order.
func eventNames(t *testing.T, raw string) []string {
	t.Helper()
	var names []string
	for _, line := range strings.Split(strings.TrimSpace(raw), "\n") {
		if line == "" {
			continue
		}
		name := line[strings.Index(line, `"event":"`)+len(`"event":"`):]
		names = append(names, name[:strings.Index(name, `"`)])
	}
	return names
}

func TestRoundEventsFromFakeWorkLoop(t *testing.T) {
	t.Parallel()
	var buf syncBuffer
	q := &fakeQueue{queue: []*agentCrawlJob{suburbJob("job-1", "Unley", "rea"), suburbJob("job-2", "Unley", "domain")}}
	res := q.round(10, newCrawlEvents(&buf), nil).run(context.Background())

	got := eventNames(t, buf.String())
	// The third claim returns nil (queue empty). It is not a job, so it emits nothing.
	want := []string{"claim", "submit", "claim", "submit"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("event sequence = %v, want %v\n%s", got, want, buf.String())
	}
	if res.processed != 2 || res.succeeded != 2 || res.listings != 8 || res.events != 4 {
		t.Fatalf("round result = %+v", res)
	}
	if !strings.Contains(buf.String(), `"job_id":"job-1"`) || !strings.Contains(buf.String(), `"outcome":"succeeded"`) {
		t.Fatalf("submit event missing job id or outcome:\n%s", buf.String())
	}
}

// Events are IDs and enums only. A suburb name, a URL or free text from the job or
// the outcome detail must not reach the bytes, so assert on the raw output.
func TestRoundEventsNeverCarrySuburbOrFreeText(t *testing.T) {
	t.Parallel()
	var buf syncBuffer
	q := &fakeQueue{queue: []*agentCrawlJob{
		suburbJob("job-1", "Hinchinbrook Heights", "rea"),
		suburbJob("job-2", "Hinchinbrook Heights", "fail"),
	}}
	ev := newCrawlEvents(&buf)
	q.round(10, ev, nil).run(context.Background())
	ev.page("job-3", "rea")
	ev.page("job-3", "Hinchinbrook Heights")
	ev.claim("Hinchinbrook Heights")
	ev.roundDone(roundResult{processed: 2}, 0)

	raw := buf.String()
	for _, banned := range []string{"Hinchinbrook", "Heights", "https://", "http://", "example.test", "blocked at"} {
		if strings.Contains(raw, banned) {
			t.Fatalf("event bytes leak %q:\n%s", banned, raw)
		}
	}
	if !strings.Contains(raw, `"job_id":"invalid"`) {
		t.Fatalf("a job id carrying a suburb name must be replaced, not echoed:\n%s", raw)
	}
}

// No event is written while the loop is waiting on the queue. A heartbeat from a
// ticker would write while the claim below is still blocked, and this would fail.
func TestNoEventsWhileTheLoopIsIdle(t *testing.T) {
	t.Parallel()
	var buf syncBuffer
	started := make(chan struct{})
	release := make(chan struct{})
	r := roundIO{
		maxJobs: 1,
		claim: func(context.Context) (*agentCrawlJob, error) {
			close(started)
			<-release
			return nil, nil
		},
		allOpen: func() (bool, time.Duration) { return false, 0 },
		runJob: func(context.Context, *agentCrawlJob) (crawlJobSummary, string, string, bool, time.Duration) {
			return crawlJobSummary{}, "", "", false, 0
		},
		submit: func(context.Context, string, string, *crawlJobSummary, string, time.Duration) error { return nil },
		pause:  func(context.Context, <-chan struct{}) {},
		blocks: newBlockTracker(2),
		events: newCrawlEvents(&buf),
		stop:   newStopSignal(),
		ppid:   func() int { return 4242 },
	}
	done := make(chan roundResult, 1)
	go func() { done <- r.run(context.Background()) }()
	<-started
	time.Sleep(150 * time.Millisecond)
	if raw := buf.String(); raw != "" {
		t.Fatalf("events written while the loop was idle (timer or heartbeat?):\n%s", raw)
	}
	close(release)
	<-done
}

func TestRoundEventsAbsentWithoutEnv(t *testing.T) {
	t.Setenv(crawlEventsFDEnv, "")
	if ev := newCrawlEventsFromEnv(); ev != nil {
		t.Fatal("CRAWL_EVENTS_FD unset must yield a disabled (nil) writer")
	}
	// A nil writer is a no-op, and the loop still runs unchanged.
	q := &fakeQueue{queue: []*agentCrawlJob{suburbJob("job-1", "Unley", "rea")}}
	res := q.round(10, nil, nil).run(context.Background())
	if res.processed != 1 || res.cancelled {
		t.Fatalf("loop changed without events: %+v", res)
	}
}

// EPIPE: the events stream fails on the first write, so the round must finish the
// job it holds and then claim nothing more.
func TestEPIPEStopsClaimingAfterCurrentJob(t *testing.T) {
	t.Parallel()
	q := &fakeQueue{queue: []*agentCrawlJob{suburbJob("job-1", "Unley", "rea"), suburbJob("job-2", "Unley", "rea"), suburbJob("job-3", "Unley", "rea")}}
	ev := newCrawlEvents(failWriter{err: syscall.EPIPE})
	res := q.round(10, ev, nil).run(context.Background())

	if q.claims != 1 {
		t.Fatalf("claims after EPIPE = %d, want 1 (the in-flight job only)", q.claims)
	}
	if res.processed != 1 || !res.cancelled || res.cancelReason != "event-pipe" {
		t.Fatalf("round result = %+v, want the job finished and a cancel for event-pipe", res)
	}
	if len(q.submits) != 1 || q.submits[0] != "job-1:succeeded" {
		t.Fatalf("the in-flight job must still be submitted: %v", q.submits)
	}
}

// The same EPIPE through a real pipe whose reader has closed. The write path must
// return EPIPE and not kill the process.
// Not parallel: a parallel test's fork inherits the read end and makes the write
// succeed, which is the flake this was dropped for.
func TestEPIPEFromRealClosedPipe(t *testing.T) {
	pr, pw, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = pw.Close() }()
	_ = pr.Close()
	ev := newCrawlEvents(pw)
	ev.claim("job-1")
	if !ev.broken() {
		t.Fatal("a write to a pipe with no reader must mark the writer broken")
	}
}

func TestOrphanedProcessStopsClaiming(t *testing.T) {
	t.Parallel()
	var orphaned atomic.Bool
	q := &fakeQueue{
		queue: []*agentCrawlJob{suburbJob("job-1", "Unley", "rea"), suburbJob("job-2", "Unley", "rea")},
		onClaim: func(n int) {
			if n == 1 {
				orphaned.Store(true)
			}
		},
	}
	r := q.round(10, nil, nil)
	r.ppid = func() int {
		if orphaned.Load() {
			return 1
		}
		return 4242
	}
	res := r.run(context.Background())
	if q.claims != 1 || res.processed != 1 || res.cancelReason != "orphaned" {
		t.Fatalf("orphaned round: claims=%d result=%+v", q.claims, res)
	}
}

// A process that started under init (launchd runs it directly) was never
// orphaned by its PPID being 1, so it must keep draining.
func TestStartedUnderInitIsNotOrphaned(t *testing.T) {
	t.Parallel()
	q := &fakeQueue{queue: []*agentCrawlJob{suburbJob("job-1", "Unley", "rea"), suburbJob("job-2", "Unley", "rea")}}
	r := q.round(10, nil, nil)
	r.ppid = func() int { return 1 }
	res := r.run(context.Background())
	if res.cancelled || res.processed != 2 {
		t.Fatalf("a process started under PPID 1 must not stop itself: %+v", res)
	}
}

// A signal that arrives while the loop is idle between suburbs ends the pause and
// the round at once, with no further claim.
func TestSignalWhileIdleBetweenJobsExitsPromptly(t *testing.T) {
	t.Parallel()
	stop := newStopSignal()
	sigs := make(chan os.Signal, 2)
	done := make(chan struct{})
	defer close(done)
	go watchSignals(sigs, done, stop, func(int) { t.Error("first signal must not exit") })

	paused := make(chan struct{}, 1)
	q := &fakeQueue{queue: []*agentCrawlJob{suburbJob("job-1", "Unley", "rea"), suburbJob("job-2", "Unley", "rea")}}
	r := q.round(10, nil, stop)
	r.pause = func(ctx context.Context, stopped <-chan struct{}) {
		paused <- struct{}{}
		jitterSleepUntil(ctx, stopped, time.Hour, time.Hour)
	}

	resCh := make(chan roundResult, 1)
	go func() { resCh <- r.run(context.Background()) }()
	<-paused
	sigs <- syscall.SIGTERM

	select {
	case res := <-resCh:
		if q.claims != 1 || res.processed != 1 || !res.cancelled || res.cancelReason != "signal" {
			t.Fatalf("idle signal: claims=%d result=%+v", q.claims, res)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("a signal while idle between jobs must end the round promptly")
	}
}

// A signal that arrives during a job lets that suburb finish and submit, then the
// round stops before claiming another.
func TestSignalDuringJobFinishesTheCurrentSuburb(t *testing.T) {
	t.Parallel()
	stop := newStopSignal()
	sigs := make(chan os.Signal, 2)
	done := make(chan struct{})
	defer close(done)
	go watchSignals(sigs, done, stop, func(int) { t.Error("first signal must not exit") })

	inJob := make(chan struct{})
	gate := make(chan struct{})
	q := &fakeQueue{queue: []*agentCrawlJob{suburbJob("job-1", "Unley", "rea"), suburbJob("job-2", "Unley", "rea")}}
	q.runDelay = func(*agentCrawlJob) {
		close(inJob)
		<-gate
	}
	resCh := make(chan roundResult, 1)
	go func() { resCh <- q.round(10, nil, stop).run(context.Background()) }()
	<-inJob
	sigs <- syscall.SIGINT
	time.Sleep(20 * time.Millisecond)
	close(gate)

	res := <-resCh
	if q.claims != 1 || len(q.submits) != 1 || q.submits[0] != "job-1:succeeded" {
		t.Fatalf("the in-flight suburb must finish and submit: claims=%d submits=%v", q.claims, q.submits)
	}
	if !res.cancelled || res.processed != 1 {
		t.Fatalf("round result = %+v", res)
	}
}

// The first signal requests a graceful stop. The second exits at once with code 10.
func TestSecondSignalExitsImmediately(t *testing.T) {
	t.Parallel()
	stop := newStopSignal()
	sigs := make(chan os.Signal, 2)
	done := make(chan struct{})
	defer close(done)
	exited := make(chan int, 1)
	go watchSignals(sigs, done, stop, func(c int) { exited <- c })

	sigs <- syscall.SIGTERM
	// The watcher records the stop on its own goroutine, so wait for it to land rather than
	// sleep for it. Then the first signal must not have exited: a select on exited with no
	// default would catch that without any timer.
	if !waitUntil(10*time.Second, func() bool { return stop.Reason() == "signal" }) {
		t.Fatalf("stop reason after first signal = %q", stop.Reason())
	}
	select {
	case c := <-exited:
		t.Fatalf("first signal exited with %d, want a graceful stop", c)
	case <-time.After(200 * time.Millisecond):
	}
	sigs <- syscall.SIGTERM
	select {
	case c := <-exited:
		if c != exitCrawlCancelled || exitCrawlCancelled != 10 {
			t.Fatalf("second signal exit code = %d, want 10", c)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("second signal must exit immediately")
	}
}

// Source-level guard for the hard rule: the event code paths must not use a
// ticker, a periodic timer or a delayed callback.
func TestEventsNeverEmittedFromTimers(t *testing.T) {
	t.Parallel()
	for _, path := range []string{"crawl_agent.go", "crawl_events.go", "crawl_signal.go"} {
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		src := string(b)
		for _, banned := range []string{"NewTicker(", "time.Tick(", "AfterFunc("} {
			if strings.Contains(src, banned) {
				t.Fatalf("%s uses %s: events must come from the work loop only", path, banned)
			}
		}
	}
}
