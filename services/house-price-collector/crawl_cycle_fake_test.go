package main

// crawl_cycle_fake_test.go is the fake child for the -mode cycle tests. The cycle re-execs
// the test binary; TestMain sees cycleFakeChildEnv and runs runCycleFakeChild instead of the
// test suite. The child's behaviour per round comes from plan.json in the directory the env
// names. Round n (0-based, counted in count) takes step n, and the last step repeats.
//
// The child emits its events through the real crawlEvents writer on CRAWL_EVENTS_FD, so the
// schema under test is the production one. It can hang, ignore or handle SIGTERM, leave a
// grandchild in its process group, run the real withCrawlLock, and write stdout noise that must
// never reach the cycle's stdout.

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
	Claims        int    `json:"claims,omitempty"`         // claim events, job-1 .. job-N
	Fetches       int    `json:"fetches,omitempty"`        // fetch events on job-1
	FetchEveryMs  int    `json:"fetch_every_ms,omitempty"` // pause between fetch events
	Pushed        int    `json:"pushed,omitempty"`         // ingest_ok events
	Quarantined   int    `json:"quarantined,omitempty"`    // of the pushed, how many quarantined
	PushFailed    int    `json:"push_failed,omitempty"`    // ingest_error events
	Processed     int    `json:"processed,omitempty"`      // round_done counts
	Succeeded     int    `json:"succeeded,omitempty"`
	Failed        int    `json:"failed,omitempty"`
	Exit          int    `json:"exit,omitempty"`       // exit code after round_done
	Hang          bool   `json:"hang,omitempty"`       // go silent after the events
	OnTerm        string `json:"on_term,omitempty"`    // "" die | "ignore" | "exit10"
	Grandchild    string `json:"grandchild,omitempty"` // "" | "sleep" | "sh_ignore_term"
	Noise         bool   `json:"noise,omitempty"`      // write to stdout (must not reach the cycle's stdout)
	Lock          bool   `json:"lock,omitempty"`       // run withCrawlLock; exit 12 when refused
	RecordEnv     bool   `json:"record_env,omitempty"` // write the environment to env-N.txt
	SkipRoundDone bool   `json:"skip_round_done,omitempty"`
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
	if step.OnTerm == "ignore" {
		signal.Ignore(syscall.SIGTERM)
	}
	ev := newCrawlEventsFromEnv()
	if step.Grandchild != "" {
		spawnFakeGrandchild(dir, tag, step.Grandchild)
	}
	if step.Lock {
		return withCrawlLock(newCrawlLockFromEnv(), func() int {
			ev.roundDone(roundResult{}, 0)
			return 0
		})
	}
	if step.OnTerm == "exit10" {
		ch := make(chan os.Signal, 1)
		signal.Notify(ch, syscall.SIGTERM)
		go func() {
			<-ch
			ev.roundDone(roundResult{processed: step.Processed}, exitCrawlCancelled)
			os.Exit(exitCrawlCancelled)
		}()
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
		ev.ingestError(job(1), "rea", "unavailable")
	}
	if step.Hang {
		time.Sleep(time.Hour)
		return 0
	}
	if !step.SkipRoundDone {
		ev.roundDone(roundResult{
			processed: step.Processed,
			succeeded: step.Succeeded,
			failed:    step.Failed,
			anyRewarm: step.Exit == 3 || step.Exit == 5,
			fatalErr:  false,
			cancelled: step.Exit == exitCrawlCancelled,
			roundExit: 0,
			wroteAny:  false,
			events:    0,
			listings:  0,
			deferred:  0,
		}, step.Exit)
	}
	return step.Exit
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

// spawnFakeGrandchild starts a process in the child's group that the cycle must kill with it.
// Its pid goes to grandchild-N.pid so the test can check it is gone.
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
