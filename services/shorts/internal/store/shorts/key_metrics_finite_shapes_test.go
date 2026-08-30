package shorts

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"testing"
)

// The shapes a non-finite value can arrive in, and the one property that
// actually matters.
//
// THE PROPERTY: nothing that survives sanitiseKeyMetrics may be a value that
// Postgres would parse into ±Inf or NaN at `::double precision`. That cast is
// what mv_screener_data does, and it is where a harmless-looking JSON string
// becomes a float nobody downstream can represent.
//
// So these tests are written against Postgres's acceptance, not against Go's.
// The two happen to agree, and the agreement is the thing worth pinning: if Go
// ever stopped accepting a spelling Postgres still takes, the guard would
// silently develop a hole.

// postgresFloatSpellings are the texts Postgres accepts in a float8 cast as
// non-finite. Case-insensitive, both signs, and the short forms.
var postgresFloatSpellings = []string{
	"Infinity", "infinity", "INFINITY",
	"-Infinity", "-infinity",
	"+Infinity",
	"inf", "Inf", "INF", "-inf", "+inf",
	"NaN", "nan", "NAN",
	// SIGNED NaN: Postgres takes these; Go's ParseFloat does not. That
	// disagreement was a real hole in the guard, found by this list.
	"-NaN", "+NaN", "-nan",
	// With the surrounding whitespace a sloppy producer leaves behind.
	" Infinity", "Infinity ", "  -inf  ",
}

func TestEverySpellingPostgresWouldAcceptIsDropped(t *testing.T) {
	for _, spelling := range postgresFloatSpellings {
		t.Run(strconv.Quote(spelling), func(t *testing.T) {
			out := sanitiseKeyMetrics(map[string]interface{}{
				"pe_ratio":   spelling,
				"market_cap": 1234.5, // a sane sibling, to prove we drop one key not all
			})
			if _, present := out["pe_ratio"]; present {
				t.Errorf("%q survived — Postgres would cast it to a non-finite float", spelling)
			}
			if out["market_cap"] != 1234.5 {
				t.Error("a finite sibling metric was dropped with it")
			}
		})
	}
}

// The guard and Postgres must agree about what counts as a number. This asserts
// the AGREEMENT rather than restating the list: every spelling above must be
// one Go also parses as non-finite, or the guard is checking something other
// than what the database will do.
// GO AND POSTGRES DISAGREE, and this records exactly where.
//
// Everything in the list must be caught by the guard. Most of it is caught by
// strconv.ParseFloat, which accepts the same spellings Postgres does — but NOT
// signed NaN. Postgres casts '-NaN' and '+NaN' to NaN; Go refuses them, because
// it takes a sign only on Inf/Infinity. Leaning on ParseFloat alone therefore
// left a hole, and this test is what found it.
//
// The assertion is on the GUARD, not on ParseFloat: what matters is that
// nothing Postgres would accept survives, however the guard achieves it.
func TestTheGuardCatchesEverythingPostgresWouldAcceptIncludingWhereGoDisagrees(t *testing.T) {
	goRefuses := 0
	for _, spelling := range postgresFloatSpellings {
		if !isNonFiniteNumber(spelling) {
			t.Errorf("%q is not caught by the guard, but Postgres casts it to a non-finite float", spelling)
		}
		if _, err := strconv.ParseFloat(strings.TrimSpace(spelling), 64); err != nil {
			goRefuses++
		}
	}
	// If this ever drops to zero, Go started accepting signed NaN and the
	// special case above became dead code — worth knowing, not worth failing.
	if goRefuses == 0 {
		t.Log("strconv.ParseFloat now accepts every spelling; the signed-NaN special case may be removable")
	}
}

// The finite side of the same coin: the guard must not start dropping values
// that are merely unparseable. Only things that ARE non-finite numbers go.
func TestTheGuardKeepsWhatPostgresWouldCastToAFiniteNumber(t *testing.T) {
	for _, s := range []string{"0", "15.2", "-3", "1e10", "  42  "} {
		if isNonFiniteNumber(s) {
			t.Errorf("%q was treated as non-finite", s)
		}
		f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
		if err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
			t.Errorf("test bug: %q is not a finite number", s)
		}
	}
}

// float32 is the branch the existing tests missed. It cannot reach production
// through JSON, but it can reach it through a Go caller, and a guard that only
// handles float64 would pass it straight through.
func TestFloat32NonFiniteValuesAreDropped(t *testing.T) {
	for name, v := range map[string]float32{
		"+Inf": float32(math.Inf(1)),
		"-Inf": float32(math.Inf(-1)),
		"NaN":  float32(math.NaN()),
	} {
		out := sanitiseKeyMetrics(map[string]interface{}{"pe_ratio": v})
		if _, present := out["pe_ratio"]; present {
			t.Errorf("float32 %s survived", name)
		}
	}
	// And a finite float32 is kept.
	out := sanitiseKeyMetrics(map[string]interface{}{"pe_ratio": float32(12.5)})
	if _, present := out["pe_ratio"]; !present {
		t.Error("a finite float32 was dropped")
	}
}

// A description is not a measurement. Stripping prose that merely mentions
// infinity would lose real content to a string match — and enrichment writes
// prose into neighbouring keys.
func TestProseThatMentionsInfinityIsKept(t *testing.T) {
	metrics := map[string]interface{}{
		"summary":     "Losses were effectively infinite this quarter.",
		"note":        "P/E is NaN because earnings are zero.",
		"description": "Infinity Mining Ltd is an ASX-listed explorer.",
		"ticker":      "INF", // a real ASX-style code that parses as a float!
	}
	out := sanitiseKeyMetrics(metrics)

	for k := range metrics {
		if k == "ticker" {
			continue // asserted separately below
		}
		if _, present := out[k]; !present {
			t.Errorf("prose key %q was dropped", k)
		}
	}
}

// A KNOWN AND ACCEPTED BOUNDARY, recorded so it is a decision rather than a
// surprise: "INF" is both a plausible ticker-ish string and a spelling Postgres
// casts to infinity. The guard drops it.
//
// That is the right trade here — key_metrics holds METRICS, its keys are
// numeric measures, and a numeric field holding the text "INF" is far more
// likely to be a broken float than a ticker. If a genuinely textual key ever
// needs to hold "INF", it does not belong in key_metrics.
func TestTheAmbiguousShortFormIsDroppedAndThatIsDeliberate(t *testing.T) {
	out := sanitiseKeyMetrics(map[string]interface{}{"ticker": "INF"})
	if _, present := out["ticker"]; present {
		t.Error("\"INF\" survived; if this changed deliberately, update the comment above")
	}
}

// Everything finite, and every non-numeric type, must pass through untouched.
// A guard that dropped more than it had to would quietly delete real data on
// every write.
func TestFiniteAndNonNumericValuesSurvive(t *testing.T) {
	metrics := map[string]interface{}{
		"pe_ratio":       15.2,
		"market_cap":     float64(1e12),
		"zero":           0.0,
		"negative":       -3.5,
		"very_large":     math.MaxFloat64,
		"very_small":     math.SmallestNonzeroFloat64,
		"an_int":         42,
		"a_bool":         true,
		"a_nil":          nil,
		"a_list":         []interface{}{1.0, 2.0},
		"a_nested_map":   map[string]interface{}{"x": 1.0},
		"numeric_string": "15.2",
	}
	out := sanitiseKeyMetrics(metrics)

	if len(out) != len(metrics) {
		for k := range metrics {
			if _, present := out[k]; !present {
				t.Errorf("%q was dropped", k)
			}
		}
	}
}

// The guard is TOP-LEVEL ONLY, and that is sufficient rather than an oversight:
// mv_screener_data reads top-level keys (`key_metrics->>'pe_ratio'`), so only a
// top-level value can reach the `::double precision` cast that causes the
// defect. This test states the boundary so a future reader does not assume
// recursion that is not there.
func TestNestedValuesAreNotInspected(t *testing.T) {
	out := sanitiseKeyMetrics(map[string]interface{}{
		"nested": map[string]interface{}{"pe_ratio": "Infinity"},
	})
	nested, ok := out["nested"].(map[string]interface{})
	if !ok {
		t.Fatal("the nested map was dropped entirely")
	}
	if nested["pe_ratio"] != "Infinity" {
		t.Error("nested values are being rewritten; the guard's scope changed")
	}
}

func TestNilAndEmptyInputsAreHandled(t *testing.T) {
	if out := sanitiseKeyMetrics(nil); out != nil {
		t.Errorf("nil in, %v out — a nil map must stay nil so the column is untouched", out)
	}
	if out := sanitiseKeyMetrics(map[string]interface{}{}); len(out) != 0 {
		t.Errorf("empty in, %v out", out)
	}
}

// The end of the funnel: whatever survives must be marshalable. encoding/json
// REFUSES a float ±Inf outright, which is how the MCP screener tool's default
// call died — so a value that got past the guard would not merely be wrong, it
// would fail the write.
func TestWhateverSurvivesCanActuallyBeMarshalled(t *testing.T) {
	metrics := map[string]interface{}{
		"pe_ratio":    math.Inf(1),
		"eps":         math.NaN(),
		"as_text":     "Infinity",
		"market_cap":  1.2e12,
		"description": "An infinity of possibilities.",
	}
	if _, err := json.Marshal(sanitiseKeyMetrics(metrics)); err != nil {
		t.Fatalf("the sanitised map still will not marshal: %v", err)
	}
	// And prove the input genuinely would have failed, so this is not vacuous.
	if _, err := json.Marshal(metrics); err == nil {
		t.Fatal("the unsanitised map marshalled — this test proves nothing")
	}
}
