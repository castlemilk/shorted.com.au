package shorts

import (
	"math"
	"strconv"
	"strings"
)

// sanitiseKeyMetrics drops any key whose value is a non-finite number, so that
// ±Inf and NaN cannot enter the key_metrics JSONB.
//
// Why here rather than at each reader: key_metrics is text in JSONB, and
// mv_screener_data casts it with `::double precision`. Postgres parses the
// string "Infinity" into a float Infinity, so the view — and therefore every
// consumer of it — inherits a number that cannot be represented on the way out.
// protojson emits it as the *string* "Infinity" inside a numeric field, which
// breaks any strict client; encoding/json refuses it outright, which took the
// MCP screener tool's default call down entirely. Two services had already
// grown their own guard for this exact value before it was fixed at the source.
//
// Dropping the key is deliberate, and better than substituting zero. Every
// reader already treats an absent metric as unknown (the view's COALESCE(...,0),
// the API's zero-value, the tools' "0 when unknown" contract). A zero written
// into the record would instead assert a measurement — a P/E of nought — that
// nobody took. An undefined ratio should read as absent.
//
// Note that Go's json.Marshal already rejects a float64 ±Inf, so the values
// that actually reached production arrived as JSON *strings*. Both shapes are
// handled: the numeric case guards a future caller, the string case is the one
// that has bitten.
func sanitiseKeyMetrics(metrics map[string]interface{}) map[string]interface{} {
	if metrics == nil {
		return nil
	}

	out := make(map[string]interface{}, len(metrics))
	for k, v := range metrics {
		if isNonFiniteNumber(v) {
			continue
		}
		out[k] = v
	}
	return out
}

// isNonFiniteNumber reports whether v is ±Inf or NaN, as a float or as a string
// that Postgres would parse into one.
//
// Only values that ARE a number count. Prose that happens to contain the word
// "infinity" is left alone — a description is not a measurement, and stripping
// it would lose real content to a string match.
func isNonFiniteNumber(v interface{}) bool {
	switch t := v.(type) {
	case float64:
		return math.IsInf(t, 0) || math.IsNaN(t)
	case float32:
		return math.IsInf(float64(t), 0) || math.IsNaN(float64(t))
	case string:
		s := strings.TrimSpace(t)

		// SIGNED NaN, handled before ParseFloat, because the two parsers
		// DISAGREE here and Postgres is the one that matters.
		//
		// Postgres accepts '-NaN' and '+NaN' in a float8 cast and yields NaN
		// (measured, not assumed). Go's strconv.ParseFloat REFUSES them — it
		// takes a sign only on Inf/Infinity, never on NaN. So relying on
		// ParseFloat alone left exactly the hole this guard exists to close: a
		// stored "-NaN" sailed through untouched and mv_screener_data's
		// ::double precision cast turned it into a NaN downstream.
		//
		// Anything else Go and Postgres agree on, so ParseFloat carries the
		// rest.
		if lower := strings.ToLower(s); lower == "-nan" || lower == "+nan" {
			return true
		}

		// ParseFloat accepts "Infinity", "-Infinity", "inf" and "NaN" in any
		// case — the same spellings Postgres accepts in a float8 cast, which is
		// what makes them dangerous here rather than merely odd.
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return false
		}
		return math.IsInf(f, 0) || math.IsNaN(f)
	default:
		return false
	}
}
