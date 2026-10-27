package main

// crawl_cycle_fake_test.go is the fake child for the -mode cycle tests. The cycle re-execs the test
// binary; TestMain sees cycleFakeChildEnv and runs runCycleFakeChild instead of the test suite. The
// child's behaviour per round comes from plan.json in the directory the env names. Round n (0-based,
// counted by bumpFakeCount) takes step n, and the last step repeats.
//
// The fake follows runAgent's real order: the SIGTERM handler is installed, then ready is written,
// and only then does any work happen. It writes its events through the real crawlEvents writer on
// CRAWL_EVENTS_FD, so the schema under test is the production one.

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// cycleFakeChildEnv names the directory that holds the child's plan and counters.
const cycleFakeChildEnv = "CYCLE_FAKE_CHILD_DIR"

// fakeStep is one round's behaviour.
type fakeStep struct {
	NoReady       bool   `json:"no_ready,omitempty"`
	SelfSignal    string `json:"self_signal,omitempty"`
	Claims        int    `json:"claims,omitempty"`         // claim events, job-1 .. job-N
	Fetches       int    `json:"fetches,omitempty"`        // fetch events on job-1
	FetchEveryMs  int    `json:"fetch_every_ms,omitempty"` // pause between fetch events
	Pushed        int    `json:"pushed,omitempty"`         // ingest_ok events
	Quarantined   int    `json:"quarantined,omitempty"`    // of the pushed, how many quarantined
	PushFailed    int    `json:"push_failed,omitempty"`    // ingest_error events
	Processed     int    `json:"processed,omitempty"`      // round_done counts
	Succeeded     int    `json:"succeeded,omitempty"`
	Failed        int    `json:"failed,omitempty"`
	Deferred      int    `json:"deferred,omitempty"`
	Blocked       int    `json:"blocked,omitempty"`       // round_done blocked_sweeps
	Exit          int    `json:"exit,omitempty"`          // exit code after round_done
	DelayExitMs   int    `json:"delay_exit_ms,omitempty"` // pause after the work, before round_done
	DelayReadyMs  int    `json:"delay_ready_ms,omitempty"`
	Hang          bool   `json:"hang,omitempty"`       // go silent after the events
	OnTerm        string `json:"on_term,omitempty"`    // "" (no handler: a TERM kills) | ignore | exit10 | count
	Grandchild    string `json:"grandchild,omitempty"` // "" | sleep | sh_ignore_term
	Noise         bool   `json:"noise,omitempty"`      // write to stdout (must not reach the cycle's stdout)
	Lock          bool   `json:"lock,omitempty"`       // run withCrawlLock
	RecordEnv     bool   `json:"record_env,omitempty"` // write the environment to env-N.txt
	SkipRoundDone bool   `json:"skip_round_done,omitempty"`
	Startup       bool   `json:"startup,omitempty"` // emit probe_auth start/done
}

// runCycleFakeChild is the fake child's main. It returns the exit code.
func runCycleFakeChild(dir string) int {
	raw, err := os.ReadFile(filepath.Join(dir, "plan.json"))
	if err != nil {
		fmt.Fprintf(os.Stderr, "fake child: %v\n", err)
		return 99
	}
	var steps []fakeStep
	if err := json.Unmarshal(raw, &steps); err != nil || len(steps) == 0 {
		fmt.Fprintf(os.Stderr, "fake child: bad plan: %v\n", err)
		return 98
	}
	idx := bumpFakeCount(dir)
	step := steps[min(idx, len(steps)-1)]
	tag := strconv.Itoa(idx)

	_ = os.WriteFile(filepath.Join(dir, "started-"+tag), []byte(strconv.Itoa(os.Getpid())), 0o644)
	if step.RecordEnv {
		_ = os.WriteFile(filepath.Join(dir, "env-"+tag+".txt"), []byte(strings.Join(os.Environ(), "\n")), 0o644)
	}
	if step.Noise {
		fmt.Println("NOISE-ON-STDOUT")
		fmt.Fprintln(os.Stderr, "stderr noise")
	}
	// As runAgent does: a dead events reader is EPIPE, not a kill.
	signal.Ignore(syscall.SIGPIPE)
	ev := newCrawlEventsFromEnv()

	if step.DelayReadyMs > 0 {
		time.Sleep(time.Duration(step.DelayReadyMs) * time.Millisecond)
	}
	// The handler comes before ready, as in runAgent.
	installFakeTermHandler(dir, step, ev)
	if !step.NoReady {
		ev.ready()
	}

	if step.Startup {
		ev.startup("probe_auth", "start", "")
		ev.startup("probe_auth", "done", "ok")
	}
	if step.Grandchild != "" {
		spawnFakeGrandchild(dir, tag, step.Grandchild)
	}
	if step.Lock {
		return withCrawlLock(newCrawlLockFromEnv(), func() int {
			ev.roundDone(roundResult{}, 0)
			return 0
		})
	}

	job := func(i int) string { return "job-" + strconv.Itoa(i) }
	for i := 1; i <= step.Claims; i++ {
		ev.claim(job(i))
	}
	for i := 1; i <= step.Fetches; i++ {
		ev.fetch(job(1), "rea", i, "ok")
		if step.FetchEveryMs > 0 {
			time.Sleep(time.Duration(step.FetchEveryMs) * time.Millisecond)
		}
	}
	for i := 0; i < step.Pushed; i++ {
		ev.ingestOK(job(1), "rea", "complete", false, i < step.Quarantined)
	}
	for i := 0; i < step.PushFailed; i++ {
		ev.ingestError("unavailable")
	}
	if step.Hang {
		time.Sleep(time.Hour)
		return 0
	}
	if step.SelfSignal == "hup" {
		// A signal the cycle never sends: SIGHUP, which the Go runtime does not catch, so the process dies
		// of it. The cycle must read that as a signal death.
		time.Sleep(time.Duration(step.DelayExitMs) * time.Millisecond)
		_ = syscall.Kill(os.Getpid(), syscall.SIGHUP)
		time.Sleep(time.Minute)
		return 0
	}
	time.Sleep(time.Duration(step.DelayExitMs) * time.Millisecond)
	if !step.SkipRoundDone {
		ev.roundDone(roundResult{
			processed:     step.Processed,
			succeeded:     step.Succeeded,
			failed:        step.Failed,
			deferred:      step.Deferred,
			blockedSweeps: step.Blocked,
			anyRewarm:     step.Exit == 3 || step.Exit == 5,
			cancelled:     step.Exit == exitCrawlCancelled,
		}, step.Exit)
	}
	// Written after round_done, so a test can tell the round has ended (the cycle is now deciding).
	_ = os.WriteFile(filepath.Join(dir, "done-"+tag), nil, 0o644)
	return step.Exit
}

// installFakeTermHandler sets the child's SIGTERM behaviour from the step. Each handled TERM is
// recorded in terms.txt, so a test can count exactly how many graceful stops the child received.
func installFakeTermHandler(dir string, step fakeStep, ev *crawlEvents) {
	switch step.OnTerm {
	case "ignore":
		signal.Ignore(syscall.SIGTERM)
	case "exit10", "count":
		ch := make(chan os.Signal, 4)
		signal.Notify(ch, syscall.SIGTERM)
		go func() {
			<-ch
			appendFakeTerm(dir)
			// Keep recording every later TERM as it arrives, so a second graceful stop is counted
			// even while this child is finishing (the sleep below does not read the channel).
			go func() {
				for range ch {
					appendFakeTerm(dir)
				}
			}()
			if step.OnTerm == "count" {
				time.Sleep(800 * time.Millisecond)
			}
			ev.roundDone(roundResult{processed: step.Processed, cancelled: true}, exitCrawlCancelled)
			os.Exit(exitCrawlCancelled)
		}()
	}
}

// appendFakeTerm records one received graceful stop.
func appendFakeTerm(dir string) {
	f, err := os.OpenFile(filepath.Join(dir, "terms.txt"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	_, _ = f.WriteString("TERM\n")
	_ = f.Close()
}

// bumpFakeCount returns the round index for this child and advances the counter.
func bumpFakeCount(dir string) int {
	p := filepath.Join(dir, "count")
	n := 0
	if b, err := os.ReadFile(p); err == nil {
		n, _ = strconv.Atoi(strings.TrimSpace(string(b)))
	}
	_ = os.WriteFile(p, []byte(strconv.Itoa(n+1)), 0o644)
	return n
}

// spawnFakeGrandchild starts a process in the child's group. Its pid goes to grandchild-N.pid, so
// a test can check the group was not signalled, and the test cleanup kills it.
func spawnFakeGrandchild(dir, tag, kind string) {
	var cmd *exec.Cmd
	switch kind {
	case "sh_ignore_term":
		cmd = exec.Command("sh", "-c", `trap "" TERM; sleep 1000`)
	default:
		cmd = exec.Command("sleep", "1000")
	}
	if err := cmd.Start(); err != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(dir, "grandchild-"+tag+".pid"), []byte(strconv.Itoa(cmd.Process.Pid)), 0o644)
	go func() { _ = cmd.Wait() }()
}
