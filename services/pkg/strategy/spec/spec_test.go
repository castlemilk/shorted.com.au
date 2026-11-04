package spec

import (
	"bufio"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// TestSpecHashesArePinned holds the rules hash of every registered version to
// the golden file. Changing a number, a rule, a weight or the layout changes a
// hash, and the golden must change in the same commit, with a changelog entry
// and an engine version bump (TestEngineVersionBumpedWithGoldens).
func TestSpecHashesArePinned(t *testing.T) {
	want := readGolden(t, filepath.Join("testdata", "spec_hashes.golden"))
	var got []string
	for _, r := range Registry() {
		h, err := RulesHash(r.Spec)
		if err != nil {
			t.Fatalf("%s %s: hash: %v", r.Spec.StrategyID, r.Label, err)
		}
		got = append(got, fmt.Sprintf("%s %s %s", r.Spec.StrategyID, r.Label, h))
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("registered rules hashes do not match testdata/spec_hashes.golden.\ncomputed:\n%s\ngolden:\n%s",
			strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

func readGolden(t *testing.T, path string) []string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open golden: %v", err)
	}
	defer f.Close()
	var lines []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		lines = append(lines, line)
	}
	if err := sc.Err(); err != nil {
		t.Fatalf("read golden: %v", err)
	}
	return lines
}

// TestCanonicalEncodingIsStable checks that the hash depends on the rules and
// on nothing else: the label, the changelog, the known issues, the live flag
// and the encoding's own run-to-run behaviour are outside it.
func TestCanonicalEncodingIsStable(t *testing.T) {
	base := Registry()[0]
	h1, err := RulesHash(base.Spec)
	if err != nil {
		t.Fatal(err)
	}
	if len(h1) != 64 {
		t.Fatalf("hash has %d hex characters, want 64", len(h1))
	}
	for i := 0; i < 5; i++ {
		b1, _ := Canonical(base.Spec)
		b2, _ := Canonical(base.Spec)
		if string(b1) != string(b2) {
			t.Fatal("canonical encoding differs between two calls")
		}
	}

	// Prose and bookkeeping are not hashed.
	relabelled := base
	relabelled.Label = "v9"
	relabelled.Live = false
	relabelled.Changes = []string{"anything"}
	relabelled.KnownIssues = nil
	if h2, _ := RulesHash(relabelled.Spec); h2 != h1 {
		t.Fatal("label, live flag, changes or known issues changed the rules hash")
	}

	// A rule value is hashed.
	changed := base.Spec
	changed.Rules = append([]RuleSpec(nil), base.Spec.Rules...)
	changed.Rules[0].Params = map[string]float64{}
	for k, v := range base.Spec.Rules[0].Params {
		changed.Rules[0].Params[k] = v
	}
	changed.Rules[0].Params["min_pct"] = 26
	if h3, _ := RulesHash(changed); h3 == h1 {
		t.Fatal("changing a threshold did not change the rules hash")
	}
}

// TestRegistryLifecycle holds the registry to its invariants: one canonical
// version per strategy is live, ids and hashes are unique, and the strategies
// are in the published order.
func TestRegistryLifecycle(t *testing.T) {
	order := []string{StrategyZangerBreakout, StrategyCANSLIM, StrategyMinerviniTrend, StrategyCrowdedShortBreakout, StrategyQualityCompounders}
	reg := Registry()
	if len(reg) != len(order) {
		t.Fatalf("registry has %d versions, want %d", len(reg), len(order))
	}
	live := map[string]int{}
	hashes := map[string]bool{}
	labels := map[string]bool{}
	for i, r := range reg {
		if r.Spec.StrategyID != order[i] {
			t.Errorf("registry[%d] is %q, want %q", i, r.Spec.StrategyID, order[i])
		}
		if r.Spec.Kind != KindCanonical {
			t.Errorf("%s: kind %q, want canonical", r.Spec.StrategyID, r.Spec.Kind)
		}
		if r.Spec.Schema != SchemaVersion || r.Spec.EngineMajor != EngineMajor {
			t.Errorf("%s: schema or engine major not set", r.Spec.StrategyID)
		}
		if r.Live {
			live[r.Spec.StrategyID]++
		}
		h, _ := RulesHash(r.Spec)
		if hashes[h] {
			t.Errorf("duplicate rules hash %s", h)
		}
		hashes[h] = true
		key := r.Spec.StrategyID + "/" + r.Label
		if labels[key] {
			t.Errorf("duplicate label %s", key)
		}
		labels[key] = true
	}
	for _, id := range order {
		if live[id] != 1 {
			t.Errorf("%s has %d live versions, want exactly 1", id, live[id])
		}
		got, ok := Live(id)
		if !ok || got.Spec.StrategyID != id {
			t.Errorf("Live(%q) = %v, %v", id, got.Spec.StrategyID, ok)
		}
	}
	if _, ok := Live("no-such-strategy"); ok {
		t.Error("Live answered for an unknown strategy")
	}
	h, _ := RulesHash(reg[0].Spec)
	if got, ok := ByHash(h); !ok || got.Spec.StrategyID != order[0] {
		t.Errorf("ByHash(%s) did not return the registered version", h)
	}
	if _, ok := ByHash("0000"); ok {
		t.Error("ByHash answered for an unknown hash")
	}
}

// TestRegistryReturnsFreshCopies checks that a caller cannot change the shared
// definitions through what Registry returns.
func TestRegistryReturnsFreshCopies(t *testing.T) {
	a := Registry()
	a[0].Spec.Rules[0].Params["min_pct"] = 999
	a[0].Spec.Features.Params["min_sessions"] = 999
	b := Registry()
	if b[0].Spec.Rules[0].Params["min_pct"] == 999 || b[0].Spec.Features.Params["min_sessions"] == 999 {
		t.Fatal("mutating a returned Registry changed the shared definition")
	}
}

// TestEvaluationProseStatesTheThresholds renders every rule of every
// registered version and checks that each parameter the rule carries appears
// in the text, so no threshold can be tested without being stated.
func TestEvaluationProseStatesTheThresholds(t *testing.T) {
	for _, r := range Registry() {
		for _, rule := range r.Spec.Rules {
			text, err := RenderRule(rule)
			if err != nil {
				t.Errorf("%s/%s: %v", r.Spec.StrategyID, rule.ID, err)
				continue
			}
			if strings.Contains(text, "{") || strings.Contains(text, "}") {
				t.Errorf("%s/%s: unrendered placeholder in %q", r.Spec.StrategyID, rule.ID, text)
			}
			keys := ProseTemplateKeys(rule.ID)
			for key, v := range rule.Params {
				if !contains(keys, key) {
					t.Errorf("%s/%s: the template does not name parameter %q", r.Spec.StrategyID, rule.ID, key)
					continue
				}
				// The value, its magnitude or its percentage form must appear.
				forms := []string{
					fmt.Sprintf("%g", v),
					fmt.Sprintf("%g", math.Abs(v)),
					fmt.Sprintf("%g", math.Round(v*100*1e9)/1e9),
				}
				found := false
				for _, f := range forms {
					if strings.Contains(text, f) {
						found = true
					}
				}
				if !found {
					t.Errorf("%s/%s: rendered text %q does not state %s = %g", r.Spec.StrategyID, rule.ID, text, key, v)
				}
			}
			for _, key := range keys {
				if _, ok := rule.Params[key]; !ok {
					t.Errorf("%s/%s: template names %q, which the rule does not carry", r.Spec.StrategyID, rule.ID, key)
				}
			}
		}
	}
}

// TestProseRendersValues pins the rendering of the placeholder forms on one
// rule, so a change to %g or to a form shows up here.
func TestProseRendersValues(t *testing.T) {
	text, err := RenderRule(RuleSpec{ID: "near_high", Params: map[string]float64{"max_off_pct": -5}})
	if err != nil {
		t.Fatal(err)
	}
	if want := "Pass when the close is no more than 5% below its 52-week high."; text != want {
		t.Fatalf("got %q, want %q", text, want)
	}
	text, err = RenderRule(RuleSpec{ID: "rs_leader", Params: map[string]float64{"quantile": 0.75}})
	if err != nil {
		t.Fatal(err)
	}
	if want := "Pass when the stock's 6-month relative strength is at or above the 75th percentile of every stock evaluated that day."; text != want {
		t.Fatalf("got %q, want %q", text, want)
	}
	if _, err := RenderRule(RuleSpec{ID: "growth", Params: map[string]float64{}}); err == nil {
		t.Fatal("a template with a missing parameter rendered without error")
	}
}

// fs1Literal ties one fs1 parameter to the SQL text it was taken from.
type fs1Literal struct {
	file  string
	match *regexp.Regexp
}

// TestFS1ParamsMatchMigrationLiterals reads the fs1 parameters back from the
// SQL they were ported from: migration 000130 for the price features and the
// regime, and 000080 for days to cover. Each parameter must appear in its
// migration with exactly its value, so a changed literal in either place fails.
func TestFS1ParamsMatchMigrationLiterals(t *testing.T) {
	const (
		m130 = "000130_add_price_features.up.sql"
		m080 = "000080_mv_logo_icons.up.sql"
	)
	literals := map[string]fs1Literal{
		"history_calendar_days":     {m130, regexp.MustCompile(`CURRENT_DATE - 400\b`)},
		"min_sessions":              {m130, regexp.MustCompile(`n_sessions\s*>=\s*60\b`)},
		"agg_sessions":              {m130, regexp.MustCompile(`rn\s*<=\s*260\b`)},
		"breakout_prior_sessions":   {m130, regexp.MustCompile(`ROWS BETWEEN 40 PRECEDING AND 1 PRECEDING`)},
		"breakout_volume_sessions":  {m130, regexp.MustCompile(`ROWS BETWEEN 50 PRECEDING AND 1 PRECEDING`)},
		"breakout_volume_min_n":     {m130, regexp.MustCompile(`prior50_n\s*>=\s*20\b`)},
		"breakout_volume_multiple":  {m130, regexp.MustCompile(`s\.volume\s*>=\s*1\.5\s*\*\s*s\.prior50_avg_volume`)},
		"breakout_window":           {m130, regexp.MustCompile(`r\.rn\s*<=\s*5\s+AND\s+r\.is_breakout`)},
		"base_window":               {m130, regexp.MustCompile(`r\.anchor_rn \+ 40\b`)},
		"touch_ratio":               {m130, regexp.MustCompile(`r\.high\s*>=\s*0\.98\s*\*\s*r\.pivot`)},
		"high_low_sessions":         {m130, regexp.MustCompile(`r\.rn\s*<=\s*252\b`)},
		"dv_sessions":               {m130, regexp.MustCompile(`avg\(r\.close \* r\.volume::float8\) FILTER \(WHERE r\.rn\s*<=\s*20\)`)},
		"dv_min_n":                  {m130, regexp.MustCompile(`count\(\*\) FILTER \(WHERE r\.rn\s*<=\s*20\)\s*>=\s*10\b`)},
		"avgvol_from":               {m130, regexp.MustCompile(`r\.rn BETWEEN 2 AND 51\)`)},
		"avgvol_to":                 {m130, regexp.MustCompile(`r\.rn BETWEEN 2 AND 51\)`)},
		"avgvol_min_n":              {m130, regexp.MustCompile(`count\(\*\) FILTER \(WHERE r\.rn BETWEEN 2 AND 51\)\s*>=\s*20\b`)},
		"ret_anchor_tolerance_days": {m130, regexp.MustCompile(`INTERVAL '10 days'`)},
		"rs_index_tolerance_days":   {m130, regexp.MustCompile(`r\.as_of - 7\b`)},
		"dtc_window_days":           {m080, regexp.MustCompile(`CURRENT_DATE - '35 days'::interval\)`)},
		"dtc_min_rows":              {m080, regexp.MustCompile(`HAVING \(count\(\*\) >= 5\)`)},
	}

	reg, ok := Live("zanger-breakout")
	if !ok {
		t.Fatal("no live version for zanger-breakout")
	}
	got := reg.Spec.Features.Params
	if len(got) != len(literals) {
		t.Fatalf("fs1 carries %d parameters, the literal table has %d", len(got), len(literals))
	}
	src := map[string]string{}
	for key, lit := range literals {
		if _, ok := got[key]; !ok {
			t.Errorf("fs1 is missing parameter %q", key)
			continue
		}
		if _, ok := src[lit.file]; !ok {
			b, err := os.ReadFile(filepath.Join("..", "..", "..", "migrations", lit.file))
			if err != nil {
				t.Fatalf("read %s: %v", lit.file, err)
			}
			src[lit.file] = string(b)
		}
		if !lit.match.MatchString(src[lit.file]) {
			t.Errorf("parameter %q = %g: %s has no matching literal (pattern %s)", key, got[key], lit.file, lit.match)
		}
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
