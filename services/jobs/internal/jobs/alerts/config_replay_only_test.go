package alerts

import (
	"bytes"
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
)

// ALERTS_REPLAY_ONLY is the replay job's own fence. Each case is a mix of arguments
// the admin tool or a console could send. Only a live run that names both one day and
// one owner is allowed.
func TestReplayOnlyRefusesALiveRunWithoutOneDayAndOneOwner(t *testing.T) {
	t.Setenv("ALERTS_DRY_RUN", "false")
	t.Setenv("ALERTS_REPLAY_ONLY", "true")
	cases := map[string][]string{
		"no arguments (the scheduled sweep's shape)": nil,
		"a date and no owner":                        {"-date", "2026-10-21"},
		"an owner and no date":                       {"-user", "uid-admin"},
		"the canary alone":                           {"-canary", "always"},
	}
	for name, args := range cases {
		_, err := parseOptions(args, runner.Globals{}, &bytes.Buffer{})
		// "-user without -date" is refused by the existing rule, which runs first; every
		// other mix is refused by this fence.
		if err == nil || (!strings.Contains(err.Error(), "ALERTS_REPLAY_ONLY") && !strings.Contains(err.Error(), "-user needs -date")) {
			t.Errorf("%s: err = %v, want a refusal", name, err)
		}
	}
}

func TestReplayOnlyAllowsTheOverrideArgvAndADryRun(t *testing.T) {
	t.Setenv("ALERTS_DRY_RUN", "false")
	t.Setenv("ALERTS_REPLAY_ONLY", "true")
	o, err := parseOptions([]string{"-date", "2026-10-21", "-user", "uid-admin", "-canary", "off"}, runner.Globals{}, &bytes.Buffer{})
	if err != nil {
		t.Fatalf("the replay argv must run live: %v", err)
	}
	if o.dryRun || o.date != "2026-10-21" || o.user != "uid-admin" {
		t.Fatalf("options = %+v", o)
	}
	// The deployed args are a dry run, so a console Execute sends nothing.
	dry, err := parseOptions([]string{"-dry-run"}, runner.Globals{}, &bytes.Buffer{})
	if err != nil {
		t.Fatalf("the deployed dry run must be accepted: %v", err)
	}
	if !dry.dryRun {
		t.Fatal("-dry-run must stay a dry run")
	}
}

// Unset, the flag leaves the scheduled sweep exactly as it was: a live run with no
// arguments is allowed.
func TestReplayOnlyIsOffUnlessSet(t *testing.T) {
	t.Setenv("ALERTS_DRY_RUN", "false")
	t.Setenv("ALERTS_REPLAY_ONLY", "")
	if _, err := parseOptions(nil, runner.Globals{}, &bytes.Buffer{}); err != nil {
		t.Fatalf("with ALERTS_REPLAY_ONLY unset a live sweep must start: %v", err)
	}
}
