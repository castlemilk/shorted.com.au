package alerts

import (
	"strings"
	"testing"
)

// An operator's replay for one account must not put that account's user id in the log.
// The summary line is logged, so it names the owner only under -verbose. The run row is
// the operator's own record and keeps the id.
func TestReplayOwnerIsLoggedOnlyUnderVerbose(t *testing.T) {
	const uid = "user-7f3c-do-not-log"
	plan := Plan{}
	quiet := options{date: "2026-10-14", user: uid}

	logged := logNote(plan, quiet)
	if strings.Contains(logged, uid) {
		t.Fatalf("the summary line must not carry the owner's id without -verbose: %q", logged)
	}
	if want := "replay 2026-10-14 user=one"; logged != want {
		t.Fatalf("log note = %q, want %q", logged, want)
	}

	sum := summary{dates: []Date{"2026-10-14"}, note: logged, canary: "ok", exit: 0}
	if strings.Contains(sum.line(), uid) {
		t.Fatalf("the logged summary leaks the owner's id: %s", sum.line())
	}

	verbose := quiet
	verbose.verbose = true
	if got := logNote(plan, verbose); !strings.Contains(got, uid) {
		t.Fatalf("-verbose names the owner in the log, got %q", got)
	}

	if got := planNote(plan, quiet); !strings.Contains(got, uid) {
		t.Fatalf("the run row keeps the owner for the operator's record, got %q", got)
	}

	all := options{date: "2026-10-14"}
	if got := logNote(plan, all); got != "replay 2026-10-14 user=all" {
		t.Fatalf("a replay for every owner logs user=all, got %q", got)
	}
}
