package main

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

func eventSchemaKeys(t *testing.T, line string) []string {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(line), &m); err != nil {
		t.Fatalf("not JSON: %v (%q)", err, line)
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func sorted(s ...string) []string {
	sort.Strings(s)
	return s
}

// The schema is the contract the parent reads. Every event carries exactly the
// documented keys, no more and no less.
func TestEventSchemaIsExact(t *testing.T) {
	t.Parallel()
	var buf syncBuffer
	ev := newCrawlEvents(&buf)
	ev.claim("job-1")
	ev.page("job-1", "rea")
	ev.submit("job-1", "deferred", 3, 2, 1)
	ev.finalizeStarted()
	ev.roundDone(roundResult{processed: 4, succeeded: 2, failed: 1, deferred: 1, listings: 9, events: 5, blockedSweeps: 1, anyRewarm: true}, 0)

	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 5 {
		t.Fatalf("want 5 events, got %d:\n%s", len(lines), buf.String())
	}
	want := [][]string{
		sorted("event", "ts", "job_id"),
		sorted("event", "ts", "job_id", "source"),
		sorted("event", "ts", "job_id", "outcome", "listings", "events", "blocked"),
		sorted("event", "ts"),
		sorted("event", "ts", "processed", "succeeded", "failed", "deferred", "listings", "events", "blocked_sweeps", "needs_rewarm", "chrome_unusable", "env_broken"),
	}
	for i, line := range lines {
		if got := eventSchemaKeys(t, line); !reflect.DeepEqual(got, want[i]) {
			t.Fatalf("event %d keys = %v, want %v\n%s", i, got, want[i], line)
		}
		var m map[string]any
		_ = json.Unmarshal([]byte(line), &m)
		if _, err := time.Parse(time.RFC3339Nano, m["ts"].(string)); err != nil {
			t.Fatalf("event %d ts %q is not RFC3339Nano: %v", i, m["ts"], err)
		}
	}
	var rd map[string]any
	_ = json.Unmarshal([]byte(lines[4]), &rd)
	if rd["event"] != "round_done" || rd["needs_rewarm"] != true || rd["processed"] != float64(4) || rd["chrome_unusable"] != false {
		t.Fatalf("round_done values wrong: %v", rd)
	}
}

func TestRoundDoneFlagsFollowExitCode(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		code                      int
		wantChrome, wantEnvBroken bool
	}{
		{code: 0},
		{code: 3},
		{code: exitChromeUnusable, wantChrome: true},
		{code: exitCrawlEnvBroken, wantEnvBroken: true},
		{code: exitCrawlCancelled},
	} {
		var buf syncBuffer
		newCrawlEvents(&buf).roundDone(roundResult{}, tc.code)
		var m map[string]any
		_ = json.Unmarshal([]byte(strings.TrimSpace(buf.String())), &m)
		if m["chrome_unusable"] != tc.wantChrome || m["env_broken"] != tc.wantEnvBroken {
			t.Fatalf("exit %d: chrome_unusable=%v env_broken=%v, want %v/%v", tc.code, m["chrome_unusable"], m["env_broken"], tc.wantChrome, tc.wantEnvBroken)
		}
	}
}

// Anything outside the enums is dropped, and a job ID that is not an ID is replaced.
func TestEventsRejectOutOfEnumValues(t *testing.T) {
	t.Parallel()
	var buf syncBuffer
	ev := newCrawlEvents(&buf)
	ev.page("job-1", "Hinchinbrook Heights")
	ev.submit("job-1", "bogus", 0, 0, 0)
	if buf.String() != "" {
		t.Fatalf("out-of-enum values must not be written:\n%s", buf.String())
	}
	ev.claim("has spaces and a/slash")
	if !strings.Contains(buf.String(), `"job_id":"invalid"`) {
		t.Fatalf("a malformed id must be replaced:\n%s", buf.String())
	}
}

// A nil writer is a valid, silent writer. Every method is a no-op.
func TestNilEventsWriterIsSilent(t *testing.T) {
	t.Parallel()
	var ev *crawlEvents
	ev.claim("job-1")
	ev.page("job-1", "rea")
	ev.submit("job-1", "succeeded", 1, 1, 0)
	ev.finalizeStarted()
	ev.roundDone(roundResult{}, 0)
	if ev.broken() {
		t.Fatal("a nil writer is never broken")
	}
	if newCrawlEvents(nil) != nil {
		t.Fatal("newCrawlEvents(nil) must be disabled")
	}
}

func TestEventsFromEnvRefusesStdioAndGarbage(t *testing.T) {
	for _, v := range []string{"0", "1", "2", "-1", "x", "3.5"} {
		t.Setenv(crawlEventsFDEnv, v)
		if ev := newCrawlEventsFromEnv(); ev != nil {
			t.Fatalf("CRAWL_EVENTS_FD=%q must disable events", v)
		}
	}
}
