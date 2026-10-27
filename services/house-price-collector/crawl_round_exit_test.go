package main

import (
	"context"
	"os"
	"syscall"
	"testing"
)

// roundWithFinalize wires a fake round whose finalize step is counted, so a test can
// assert that finalize ran (committed work is finalized even when cancelled).
func roundWithFinalize(q *fakeQueue, maxJobs int, stop *stopSignal, finalized *int) roundIO {
	r := q.round(maxJobs, nil, stop)
	r.finalize = func(res *roundResult) { *finalized++ }
	return r
}

// A signal during the LAST job of the round must exit 10, with finalize run.
// Before the fix the stop latch was only checked at the top of the loop, so this
// round exited 0 and the wrapper started another round.
func TestRoundSignalDuringLastJobExitsCancelledAfterFinalize(t *testing.T) {
	stop := newStopSignal()
	sigs := make(chan os.Signal, 2)
	done := make(chan struct{})
	defer close(done)
	go watchSignals(sigs, done, stop, func(int) { t.Error("first signal must not exit") })

	q := &fakeQueue{queue: []*agentCrawlJob{suburbJob("job-1", "Unley", "rea"), suburbJob("job-2", "Unley", "rea")}}
	q.runDelay = func(job *agentCrawlJob) {
		if job.ID == "job-2" {
			sigs <- syscall.SIGTERM
			<-stop.Done()
		}
	}
	finalized := 0
	res := roundWithFinalize(q, 2, stop, &finalized).run(context.Background())

	if !res.cancelled || res.cancelReason != "signal" {
		t.Fatalf("a signal during the last job must cancel the round: %+v", res)
	}
	if res.processed != 2 {
		t.Fatalf("the in-flight last job must finish: processed=%d", res.processed)
	}
	if finalized != 1 {
		t.Fatalf("finalize ran %d times after a cancelled round, want exactly 1", finalized)
	}
	if code := finalExitCode(res); code != exitCrawlCancelled {
		t.Fatalf("exit code = %d, want %d", code, exitCrawlCancelled)
	}
}

// A signal during a job that then trips the blocked-sweep stop must exit 10, not 3.
// Under the wrapper, 3 retries after 900s, and SIGTERM must mean no retry.
func TestRoundSignalPlusTwoBlockedSweepsExitsCancelledNotRewarm(t *testing.T) {
	stop := newStopSignal()
	sigs := make(chan os.Signal, 2)
	done := make(chan struct{})
	defer close(done)
	go watchSignals(sigs, done, stop, func(int) { t.Error("first signal must not exit") })

	// Two blocked sweeps on DIFFERENT suburbs trip the degraded-session stop.
	q := &fakeQueue{queue: []*agentCrawlJob{suburbJob("job-a", "Unley", "fail"), suburbJob("job-b", "Hinchinbrook", "fail")}}
	q.runDelay = func(job *agentCrawlJob) {
		if job.ID == "job-b" {
			sigs <- syscall.SIGTERM
			<-stop.Done()
		}
	}
	finalized := 0
	res := roundWithFinalize(q, 10, stop, &finalized).run(context.Background())

	if !res.anyRewarm {
		t.Fatalf("two blocked sweeps across suburbs must still request a re-warm: %+v", res)
	}
	if !res.cancelled {
		t.Fatalf("the signal must still be recorded when it lands in a blocked job: %+v", res)
	}
	if code := finalExitCode(res); code != exitCrawlCancelled {
		t.Fatalf("signal + two blocked sweeps: exit %d, want %d (not 3)", code, exitCrawlCancelled)
	}
}

// Without a signal the same two blocked sweeps still exit 3. The rewarm contract
// is unchanged for the wrapper.
func TestRoundTwoBlockedSweepsWithoutSignalStillExitsRewarm(t *testing.T) {
	stop := newStopSignal()
	q := &fakeQueue{queue: []*agentCrawlJob{suburbJob("job-a", "Unley", "fail"), suburbJob("job-b", "Hinchinbrook", "fail")}}
	finalized := 0
	res := roundWithFinalize(q, 10, stop, &finalized).run(context.Background())
	if res.cancelled {
		t.Fatalf("no signal, no cancel: %+v", res)
	}
	if code := finalExitCode(res); code != 3 {
		t.Fatalf("exit = %d, want 3", code)
	}
}

// A cancelled round that wrote nothing has nothing to finalize.
func TestRoundCancelledWithNothingWrittenSkipsFinalize(t *testing.T) {
	stop := newStopSignal()
	stop.request("signal")
	q := &fakeQueue{queue: []*agentCrawlJob{suburbJob("job-1", "Unley", "fail")}}
	finalized := 0
	res := roundWithFinalize(q, 10, stop, &finalized).run(context.Background())
	if finalized != 0 {
		t.Fatalf("finalize ran for a round that wrote nothing")
	}
	if code := finalExitCode(res); code != exitCrawlCancelled {
		t.Fatalf("exit = %d, want %d", code, exitCrawlCancelled)
	}
}

// The exit-code mapping is a pure function, so each precedence rule is pinned here.
func TestFinalExitCodePrecedence(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		res  roundResult
		want int
	}{
		{"cancelled beats rewarm", roundResult{cancelled: true, anyRewarm: true}, 10},
		{"cancelled beats clean zero", roundResult{cancelled: true}, 10},
		{"cancelled beats a fatal round (10)", roundResult{cancelled: true, fatalErr: true}, exitCrawlCancelled},
		{"rewarm alone is 3", roundResult{anyRewarm: true}, 3},
		{"fatal alone is 7", roundResult{fatalErr: true}, 7},
		{"clean is 0", roundResult{}, 0},
	}
	for _, tc := range cases {
		if got := finalExitCode(tc.res); got != tc.want {
			t.Errorf("%s: finalExitCode = %d, want %d", tc.name, got, tc.want)
		}
	}
}
