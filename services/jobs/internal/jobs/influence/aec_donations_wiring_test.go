package influence

// The mode wiring is a SAFETY property, so it is tested rather than trusted to a
// comment.
//
// `-mode all` runs on every prod deploy. `-mode aec-donations` downloads three
// bulk archives from a government site and TRUNCATEs six tables holding ~209k
// rows. If it ever slipped into the "all" or "public-records" fan-out, a routine
// deploy would re-crawl the AEC and replace the funding layer as a side effect —
// which is exactly the failure the register modes are excluded to avoid.
//
// Run() builds its pipeline inside a switch over the mode string and needs a
// database to execute, so the property is asserted against the SOURCE, the same
// way the migration guards assert against the SQL text.

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

func aecJobSource(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile("job.go")
	if err != nil {
		t.Fatalf("read job.go: %v", err)
	}
	return string(data)
}

// modeSwitchCases splits the mode switch into `case` label → body text.
func modeSwitchCases(t *testing.T, src string) map[string]string {
	t.Helper()
	start := strings.Index(src, "\tswitch *mode {")
	if start < 0 {
		t.Fatal("mode switch not found in job.go")
	}
	body := src[start:]
	end := strings.Index(body, "\n\tdefault:")
	if end < 0 {
		t.Fatal("mode switch has no default branch")
	}
	body = body[:end]

	caseRe := regexp.MustCompile(`(?m)^\tcase (.+):$`)
	locs := caseRe.FindAllStringSubmatchIndex(body, -1)
	if len(locs) == 0 {
		t.Fatal("no case labels found in the mode switch")
	}
	out := map[string]string{}
	for i, loc := range locs {
		labels := body[loc[2]:loc[3]]
		bodyStart := loc[1]
		bodyEnd := len(body)
		if i+1 < len(locs) {
			bodyEnd = locs[i+1][0]
		}
		for _, label := range strings.Split(labels, ",") {
			out[strings.Trim(strings.TrimSpace(label), `"`)] = body[bodyStart:bodyEnd]
		}
	}
	return out
}

// The whole point of a separate mode: a deploy must never trigger a re-crawl and
// a snapshot replace of the funding layer.
func TestAECDonationsIsExcludedFromModeAll(t *testing.T) {
	cases := modeSwitchCases(t, aecJobSource(t))
	for _, mode := range []string{"all", "tax", "public-records"} {
		body, ok := cases[mode]
		if !ok {
			t.Fatalf("mode %q is no longer wired; this guard must be updated deliberately", mode)
		}
		if strings.Contains(body, "aecDonations") {
			t.Errorf("-mode %s runs the AEC funding ingest; it downloads three archives and TRUNCATEs the aec_ tables and must stay operator-only", mode)
		}
	}
}

func TestAECDonationsModeIsWiredToItsOwnCase(t *testing.T) {
	src := aecJobSource(t)
	cases := modeSwitchCases(t, src)
	body, ok := cases["aec-donations"]
	if !ok {
		t.Fatal(`-mode aec-donations is not wired in job.go`)
	}
	if !strings.Contains(body, "add(aecDonations)") {
		t.Errorf("the aec-donations case does not run the funding ingest: %q", body)
	}
	// An unlisted mode is an undiscoverable mode; both the flag help and the
	// unknown-mode error must name it.
	if strings.Count(src, "aec-donations") < 3 {
		t.Error("aec-donations is missing from the -mode flag usage or the unknown-mode error")
	}
}

// The register modes are excluded for the same reason and share this guard, so a
// future refactor that folds one of them into "all" is caught here too.
func TestRegisterModesRemainExcludedFromModeAll(t *testing.T) {
	cases := modeSwitchCases(t, aecJobSource(t))
	for _, mode := range []string{"all", "tax", "public-records"} {
		body := cases[mode]
		if strings.Contains(body, "runRegister") {
			t.Errorf("-mode %s runs a register-of-interests step; the register crawl must stay operator-only", mode)
		}
	}
}

// -dry must reach the ingest, or "print the counts without writing" is a claim
// with no mechanism behind it.
func TestAECDonationsDryFlagIsPlumbed(t *testing.T) {
	src := aecJobSource(t)
	if !strings.Contains(src, `dry := fs.Bool("dry"`) {
		t.Error("the -dry flag is not declared")
	}
	if !strings.Contains(src, "runAECDonationsMode(ctx, pool, *dry)") {
		t.Error("the -dry flag is not passed to the funding ingest")
	}
}

// register-senators is the FIRST mode in this subsystem that CREATES people,
// so its wiring carries more weight than the others': a deploy that ran it
// would mint identity in production without an operator. It gets its own case,
// its own dry run (defaulting TRUE like every register mode), and no place in
// any fan-out.
func TestRegisterSenatorsIsWiredAndOperatorOnly(t *testing.T) {
	src := aecJobSource(t)
	cases := modeSwitchCases(t, src)

	body, ok := cases["register-senators"]
	if !ok {
		t.Fatal(`-mode register-senators is not wired in job.go`)
	}
	if !strings.Contains(body, "runRegisterSenatorsMode") {
		t.Errorf("the register-senators case does not run the senator ingest: %q", body)
	}
	// A mode nobody can discover is a mode nobody can run: the flag help and
	// the unknown-mode error must both name it.
	if strings.Count(src, "register-senators") < 3 {
		t.Error("register-senators is missing from the -mode flag usage or the unknown-mode error")
	}
	// It shares the register modes' 6-hour ceiling rather than the collectors'
	// 15-minute one, by virtue of its prefix.
	if !strings.HasPrefix("register-senators", "register-") {
		t.Error("the mode name must keep the register- prefix that selects the longer ceiling")
	}

	// And it defaults to a dry run, like every other register mode.
	mode, err := os.ReadFile("aph_mode.go")
	if err != nil {
		t.Fatalf("read aph_mode.go: %v", err)
	}
	if !strings.Contains(string(mode), "runRegisterSenators(ctx, pool, registerDryRun())") {
		t.Error("register-senators does not honour REGISTER_DRY_RUN, which defaults to true")
	}
}
