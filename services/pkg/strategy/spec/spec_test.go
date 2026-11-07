package spec

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// TestSpecHashesArePinned holds the rules hash of every registered version to
// the golden file. Changing a number, a rule, a weight or the layout changes a
// hash, and the golden must change in the same commit, with a changelog entry.
// The engine version is not part of this: it changes only when the engine's
// output does (engine.TestEngineVersionBumpedWithGoldens).
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
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	var lines []string
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		lines = append(lines, line)
	}
	return lines
}

// TestCanonicalEncodingIsStable checks that the hash depends on the rules and
// on nothing else: the label, the changelog, the known issues, the live flag and
// the encoding's own run-to-run behaviour are outside it.
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
	// Each strategy publishes v0 then v1, so the order names every strategy twice.
	var order []string
	for _, id := range []string{StrategyZangerBreakout, StrategyCANSLIM, StrategyMinerviniTrend, StrategyCrowdedShortBreakout, StrategyQualityCompounders} {
		order = append(order, id, id)
	}
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
	for i := 0; i < len(order); i += 2 {
		id := order[i]
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

// TestRequiresCoverEveryRuleSource checks that each registered version lists,
// in Requires, every data source its rules read, including the index behind the
// relative-strength rules. Requires drives the "Not computable before" line, so
// a missing source would hide the date a rule first has its inputs.
func TestRequiresCoverEveryRuleSource(t *testing.T) {
	for _, r := range Registry() {
		have := map[string]bool{}
		for _, q := range r.Spec.Requires {
			have[q.Source] = true
		}
		for _, rule := range r.Spec.Rules {
			for _, src := range ruleDefs[rule.ID].sources {
				if !have[src] {
					t.Errorf("%s: rule %s reads %s, which Requires does not list", r.Spec.StrategyID, rule.ID, src)
				}
			}
		}
	}
	for _, id := range []string{"rs", "rs_leader"} {
		if !contains(ruleDefs[id].sources, "index:XJO") {
			t.Errorf("rule %s is relative to the index but its sources are %v", id, ruleDefs[id].sources)
		}
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
			if strings.Contains(text, "e+") {
				t.Errorf("%s/%s: exponent form in %q", r.Spec.StrategyID, rule.ID, text)
			}
			keys := ProseTemplateKeys(rule.ID)
			for key, v := range rule.Params {
				if !contains(keys, key) {
					t.Errorf("%s/%s: the template does not name parameter %q", r.Spec.StrategyID, rule.ID, key)
					continue
				}
				// The value, its magnitude or its percentage form, plain or grouped.
				forms := []string{
					FormatNumber(v),
					FormatNumber(math.Abs(v)),
					FormatNumber(math.Round(v*100*1e9) / 1e9),
					GroupThousands(FormatNumber(v)),
					GroupThousands(FormatNumber(math.Abs(v))),
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

// TestProseRendersValues pins the rendering of the placeholder forms, so a
// change to a form, or a value printed in exponent form, shows up here.
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

	// Dollar thresholds at and above the scale the variants reach print in
	// plain decimal notation, grouped.
	for _, tc := range []struct {
		min  float64
		want string
	}{
		{250000, "A$250,000."},
		{1000000, "A$1,000,000."},
		{2500000, "A$2,500,000."},
		{10000000, "A$10,000,000."},
	} {
		text, err := RenderRule(RuleSpec{ID: "liquidity", Params: map[string]float64{"min_aud": tc.min, "sessions": 20}})
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasSuffix(text, tc.want) {
			t.Errorf("min_aud %g rendered %q, want it to end %q", tc.min, text, tc.want)
		}
	}
}

// TestProseOrdinalsAndPlurals pins the forms the templates print for a
// percentile and a count of days, across the quantile bounds of the variants.
func TestProseOrdinalsAndPlurals(t *testing.T) {
	for q, want := range map[float64]string{0.5: "50th", 0.51: "51st", 0.62: "62nd", 0.73: "73rd", 0.75: "75th", 0.82: "82nd", 0.83: "83rd", 0.92: "92nd", 0.95: "95th", 0.11: "11th", 0.12: "12th"} {
		text, err := RenderRule(RuleSpec{ID: "rs_leader", Params: map[string]float64{"quantile": q}})
		if err != nil {
			t.Fatalf("quantile %g: %v", q, err)
		}
		if !strings.Contains(text, "at or above the "+want+" percentile") {
			t.Errorf("quantile %g rendered %q, want %s", q, text, want)
		}
	}
	if _, err := RenderRule(RuleSpec{ID: "rs_leader", Params: map[string]float64{"quantile": 0.755}}); err == nil {
		t.Error("a quantile that is not a whole percentage rendered without error")
	}
	for min, want := range map[float64]string{1: "covers at least 1 day of", 2: "covers at least 2 days of", 5: "covers at least 5 days of"} {
		text, err := RenderRule(RuleSpec{ID: "days_to_cover", Params: map[string]float64{"min": min}})
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(text, want) {
			t.Errorf("min %g rendered %q, want %q", min, text, want)
		}
	}
}

// TestProseStatesThePassPaths checks the phrases that name a pass the engine
// grants beyond the threshold, and the boundary a close must clear. Each one
// is a case the reader would otherwise be told the rule does not pass.
func TestProseStatesThePassPaths(t *testing.T) {
	for _, c := range []struct {
		rule   RuleSpec
		phrase string
	}{
		{RuleSpec{ID: "growth", Params: map[string]float64{"min_pct": 25}}, "swung from a net loss to a net profit"},
		{RuleSpec{ID: "eps_growth", Params: map[string]float64{"min_pct": 25}}, "swung from a net loss to a net profit"},
		{RuleSpec{ID: "regime", Params: map[string]float64{"sma_fast": 50, "sma_slow": 200}}, "closes strictly above its 200-day average"},
		{RuleSpec{ID: "regime", Params: map[string]float64{"sma_fast": 50, "sma_slow": 200}}, "Unknown without enough index data"},
	} {
		text, err := RenderRule(c.rule)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(text, c.phrase) {
			t.Errorf("%s rendered %q, which does not state %q", c.rule.ID, text, c.phrase)
		}
	}
}

func TestGroupThousands(t *testing.T) {
	for in, want := range map[string]string{
		"0":          "0",
		"123":        "123",
		"1234":       "1,234",
		"-1234567.5": "-1,234,567.5",
		"10000000":   "10,000,000",
	} {
		if got := GroupThousands(in); got != want {
			t.Errorf("GroupThousands(%q) = %q, want %q", in, got, want)
		}
	}
}

// fs1Literal is one place the migrations state fs1 parameters: a pattern whose
// capture groups are the numbers, in the order of params. A place agrees when
// every one of its numbers equals the spec's value.
type fs1Literal struct {
	file   string
	match  *regexp.Regexp
	params []string
}

const (
	migrationPriceFeatures = "000130_add_price_features.up.sql"
	migrationDaysToCover   = "000080_mv_logo_icons.up.sql"
)

// fs1Literals ties every fs1 parameter to the SQL it was ported from.
var fs1Literals = []fs1Literal{
	{migrationPriceFeatures, regexp.MustCompile(`sp\.date\s*>=\s*CURRENT_DATE - (\d+)\b`), []string{"history_calendar_days"}},
	{migrationPriceFeatures, regexp.MustCompile(`r\.n_sessions\s*>=\s*(\d+)\s+AND\s+r\.rn\s*<=\s*(\d+)\b`), []string{"min_sessions", "agg_sessions"}},
	{migrationPriceFeatures, regexp.MustCompile(`BETWEEN\s+(\d+)\s+PRECEDING\s+AND\s+1\s+PRECEDING\)\s+AS\s+prior40_high`), []string{"breakout_prior_sessions"}},
	{migrationPriceFeatures, regexp.MustCompile(`BETWEEN\s+(\d+)\s+PRECEDING\s+AND\s+1\s+PRECEDING\)\s+AS\s+prior50_avg_volume`), []string{"breakout_volume_sessions"}},
	{migrationPriceFeatures, regexp.MustCompile(`prior50_n\s*>=\s*(\d+)\b`), []string{"breakout_volume_min_n"}},
	{migrationPriceFeatures, regexp.MustCompile(`s\.volume\s*>=\s*([0-9.]+)\s*\*\s*s\.prior50_avg_volume`), []string{"breakout_volume_multiple"}},
	{migrationPriceFeatures, regexp.MustCompile(`r\.rn\s*<=\s*(\d+)\s+AND\s+r\.is_breakout`), []string{"breakout_window"}},
	{migrationPriceFeatures, regexp.MustCompile(`r\.rn BETWEEN r\.anchor_rn \+ 1 AND r\.anchor_rn \+ (\d+)\b`), []string{"base_window"}},
	{migrationPriceFeatures, regexp.MustCompile(`r\.high\s*>=\s*([0-9.]+)\s*\*\s*r\.pivot`), []string{"touch_ratio"}},
	{migrationPriceFeatures, regexp.MustCompile(`\(WHERE r\.rn\s*<=\s*(\d+)\)\s+AS\s+high_52w`), []string{"high_low_sessions"}},
	{migrationPriceFeatures, regexp.MustCompile(`count\(\*\) FILTER \(WHERE r\.rn\s*<=\s*(\d+)\)\s*>=\s*(\d+)\b`), []string{"dv_sessions", "dv_min_n"}},
	{migrationPriceFeatures, regexp.MustCompile(`avg\(r\.close \* r\.volume::float8\) FILTER \(WHERE r\.rn\s*<=\s*(\d+)\)`), []string{"dv_sessions"}},
	{migrationPriceFeatures, regexp.MustCompile(`count\(\*\) FILTER \(WHERE r\.rn BETWEEN (\d+) AND (\d+)\)\s*>=\s*(\d+)\b`), []string{"avgvol_from", "avgvol_to", "avgvol_min_n"}},
	{migrationPriceFeatures, regexp.MustCompile(`INTERVAL '(\d+) days'`), []string{"ret_anchor_tolerance_days"}},
	{migrationPriceFeatures, regexp.MustCompile(`r\.as_of - (\d+)\b`), []string{"rs_index_tolerance_days"}},
	{migrationDaysToCover, regexp.MustCompile(`stock_prices\.date >= \(CURRENT_DATE - '(\d+) days'::interval\)\) AND \(stock_prices\.volume > 0\)`), []string{"dtc_window_days"}},
	{migrationDaysToCover, regexp.MustCompile(`HAVING \(count\(\*\) >= (\d+)\)`), []string{"dtc_min_rows"}},
}

// fs1Mismatches returns, sorted, each fs1 parameter that no literal in the
// migration text states with its value. A literal states its parameters when it
// matches at least once and every match carries the spec's values, so a pattern
// that also matches an unrelated clause cannot pass on that clause's number. A
// parameter no literal names at all is reported too.
func fs1Mismatches(params map[string]float64, sql map[string]string) []string {
	agreed := map[string]bool{}
	for _, lit := range fs1Literals {
		matches := lit.match.FindAllStringSubmatch(sql[lit.file], -1)
		if len(matches) == 0 {
			continue
		}
		ok := true
	matching:
		for _, m := range matches {
			for i, key := range lit.params {
				want, has := params[key]
				got, err := strconv.ParseFloat(m[i+1], 64)
				if !has || err != nil || got != want {
					ok = false
					break matching
				}
			}
		}
		if ok {
			for _, key := range lit.params {
				agreed[key] = true
			}
		}
	}
	var out []string
	for key, v := range params {
		if !agreed[key] {
			out = append(out, fmt.Sprintf("%s = %g", key, v))
		}
	}
	sort.Strings(out)
	return out
}

func loadMigrations(t *testing.T) map[string]string {
	t.Helper()
	sql := map[string]string{}
	for _, file := range []string{migrationPriceFeatures, migrationDaysToCover} {
		b, err := os.ReadFile(filepath.Join("..", "..", "..", "migrations", file))
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		sql[file] = string(b)
	}
	return sql
}

// TestFS1ParamsMatchMigrationLiterals holds the fs1 parameters of every
// registered version to the SQL they were ported from: migration 000130 for the
// price features and the regime, and 000080 for days to cover. A changed value
// on either side fails.
func TestFS1ParamsMatchMigrationLiterals(t *testing.T) {
	sql := loadMigrations(t)
	for _, r := range Registry() {
		for _, key := range fs1Mismatches(r.Spec.Features.Params, sql) {
			t.Errorf("%s %s: fs1 %s: no migration literal states this value", r.Spec.StrategyID, r.Label, key)
		}
	}
}

// regimeLiterals ties the regime's averages to the SQL of mv_market_regime.
var regimeLiterals = map[string]*regexp.Regexp{
	"sma_fast": regexp.MustCompile(`<= (\d+)\) END\s+AS sma50\b`),
	"sma_slow": regexp.MustCompile(`<= (\d+)\) END\s+AS sma200\b`),
}

// TestRegimeWindowsMatchMigrationLiterals holds each version's regime averages
// to the windows of mv_market_regime in migration 000130.
func TestRegimeWindowsMatchMigrationLiterals(t *testing.T) {
	sql := loadMigrations(t)[migrationPriceFeatures]
	for _, r := range Registry() {
		want := map[string]int{"sma_fast": r.Spec.Regime.SMAFast, "sma_slow": r.Spec.Regime.SMASlow}
		for key, re := range regimeLiterals {
			matches := re.FindAllStringSubmatch(sql, -1)
			if len(matches) == 0 {
				t.Errorf("%s %s: no migration literal states the regime %s", r.Spec.StrategyID, r.Label, key)
				continue
			}
			for _, m := range matches {
				if got, _ := strconv.Atoi(m[1]); got != want[key] {
					t.Errorf("%s %s: regime %s = %d, migration states %d", r.Spec.StrategyID, r.Label, key, want[key], got)
				}
			}
		}
	}
}

// strategyViewDefiners names the migration that defines each view the fs1
// literals are read from. A later migration that redefines a view changes the
// live behaviour, so TestStrategyViewsDefinedWhereTheLiteralsAre fails until
// the literals are pointed at the new definition.
var strategyViewDefiners = map[string]string{
	"mv_price_features": migrationPriceFeatures,
	"mv_market_regime":  migrationPriceFeatures,
	"mv_screener_data":  migrationDaysToCover,
}

// TestStrategyViewsDefinedWhereTheLiteralsAre checks that the migration which
// last creates each strategy view is the one the fs1 literals are read from.
func TestStrategyViewsDefinedWhereTheLiteralsAre(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "migrations")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read migrations: %v", err)
	}
	var files []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".up.sql") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files) // zero-padded numbers: name order is publication order
	for view, pinned := range strategyViewDefiners {
		create := regexp.MustCompile(`(?i)CREATE\s+MATERIALIZED\s+VIEW\s+(IF\s+NOT\s+EXISTS\s+)?` + regexp.QuoteMeta(view) + `\b`)
		last := ""
		for _, f := range files {
			b, err := os.ReadFile(filepath.Join(dir, f))
			if err != nil {
				t.Fatalf("read %s: %v", f, err)
			}
			if create.Match(b) {
				last = f
			}
		}
		if last != pinned {
			t.Errorf("%s is last defined in %s, but the fs1 literals are read from %s", view, last, pinned)
		}
	}
}

// TestFS1LiteralsCatchAChangedValue shows that the check fails when a value
// moves on the spec side, so the pass above means something.
func TestFS1LiteralsCatchAChangedValue(t *testing.T) {
	sql := loadMigrations(t)
	live, _ := Live("zanger-breakout")
	if got := fs1Mismatches(live.Spec.Features.Params, sql); len(got) != 0 {
		t.Fatalf("the live fs1 parameters already disagree with the migrations: %v", got)
	}
	for _, tc := range []struct {
		key string
		val float64
	}{
		{"touch_ratio", 0.97},
		{"history_calendar_days", 365},
		{"min_sessions", 61},
		{"dtc_window_days", 20},
		{"dtc_window_days", 90},
		{"avgvol_to", 50},
		{"base_window", 1},
	} {
		params := copyParams(live.Spec.Features.Params)
		params[tc.key] = tc.val
		got := fs1Mismatches(params, sql)
		// A literal that states several numbers together (a comparison and its
		// window, say) fails as one, so the siblings may be listed too.
		if !hasKeyPrefix(got, tc.key+" ") {
			t.Errorf("%s = %g: mismatches %v, want %s listed", tc.key, tc.val, got, tc.key)
		}
	}
	params := copyParams(live.Spec.Features.Params)
	params["unlisted_param"] = 1
	if got := fs1Mismatches(params, sql); !contains(got, "unlisted_param = 1") {
		t.Errorf("a parameter no literal names was not reported: %v", got)
	}
}

// TestMirroredValuesAgree checks the values a version states twice: the rule
// copy and the feature parameter (or the regime and its rule) that compute the
// same quantity. Each pair must be equal, so one cannot drift from the other.
func TestMirroredValuesAgree(t *testing.T) {
	type pair struct {
		what      string
		got, want float64
	}
	for _, r := range Registry() {
		sp := r.Spec
		f := sp.Features.Params
		name := sp.StrategyID + " " + r.Label
		pairs := []pair{
			{"universe min sessions vs min_sessions", float64(sp.Universe.MinSessions), f["min_sessions"]},
			{"universe lookback days vs history_calendar_days", float64(sp.Universe.LookbackDays), f["history_calendar_days"]},
		}
		for _, rule := range sp.Rules {
			p := rule.Params
			switch rule.ID {
			case "breakout":
				pairs = append(pairs,
					pair{"breakout window vs breakout_window", p["window_sessions"], f["breakout_window"]},
					pair{"breakout prior sessions vs breakout_prior_sessions", p["prior_sessions"], f["breakout_prior_sessions"]},
					pair{"breakout volume multiple vs breakout_volume_multiple", p["volume_multiple"], f["breakout_volume_multiple"]},
					pair{"breakout volume sessions vs breakout_volume_sessions", p["volume_sessions"], f["breakout_volume_sessions"]},
				)
			case "base":
				pairs = append(pairs, pair{"base window vs base_window", p["window_sessions"], f["base_window"]})
			case "liquidity":
				pairs = append(pairs, pair{"liquidity sessions vs dv_sessions", p["sessions"], f["dv_sessions"]})
			case "regime":
				pairs = append(pairs,
					pair{"regime rule sma_fast vs the regime's SMAFast", p["sma_fast"], float64(sp.Regime.SMAFast)},
					pair{"regime rule sma_slow vs the regime's SMASlow", p["sma_slow"], float64(sp.Regime.SMASlow)},
				)
			}
		}
		for _, pr := range pairs {
			if pr.got != pr.want {
				t.Errorf("%s: %s: %g and %g", name, pr.what, pr.got, pr.want)
			}
		}
	}
}

// TestRegistryChangelogAndLabels holds every registered version to a changelog
// entry and to labels that increase within its strategy. The hash golden is
// only changed alongside a changelog entry, so an empty entry is a missing one.
func TestRegistryChangelogAndLabels(t *testing.T) {
	last := map[string]int{}
	for _, r := range Registry() {
		name := r.Spec.StrategyID + " " + r.Label
		if len(r.Changes) == 0 {
			t.Errorf("%s: no changelog entry", name)
		}
		n, err := strconv.Atoi(strings.TrimPrefix(r.Label, "v"))
		if err != nil || !strings.HasPrefix(r.Label, "v") {
			t.Errorf("%s: label %q is not v<number>", name, r.Label)
			continue
		}
		if prev, seen := last[r.Spec.StrategyID]; seen && n <= prev {
			t.Errorf("%s: label does not follow v%d", name, prev)
		}
		last[r.Spec.StrategyID] = n
	}
}

func hasKeyPrefix(list []string, prefix string) bool {
	for _, v := range list {
		if strings.HasPrefix(v, prefix) {
			return true
		}
	}
	return false
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
