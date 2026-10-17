package extractiontrust

import (
	"encoding/json"
	"sort"
)

// TrustedEntries is the trust funnel for ONE stored metric class value of
// financial_report_extractions.metrics. The extractor stores a class as one
// object or, when the class repeats, as a list of objects; both shapes are read.
// It returns, in stored order, every entry that passes GroundedEntry, each a
// fresh copy with the provenance keys removed (StripProvenanceEntry). Anything
// that is not an object (a string, a number, null) is dropped. dropped counts
// the entries that were present but failed.
//
// v is the value as decoded by encoding/json into any (map[string]any or
// []any), or a json.RawMessage holding the same.
func TrustedEntries(v any) (entries []map[string]any, dropped int) {
	if raw, ok := v.(json.RawMessage); ok {
		var decoded any
		if err := json.Unmarshal(raw, &decoded); err != nil {
			return nil, 1
		}
		v = decoded
	}
	var candidates []any
	switch x := v.(type) {
	case map[string]any:
		candidates = []any{x}
	case []any:
		candidates = x
	case []map[string]any:
		for _, e := range x {
			candidates = append(candidates, e)
		}
	case nil:
		return nil, 0
	default:
		return nil, 1
	}
	for _, c := range candidates {
		entry, ok := c.(map[string]any)
		if !ok || !GroundedEntry(entry) {
			dropped++
			continue
		}
		entries = append(entries, StripProvenanceEntry(entry))
	}
	return entries, dropped
}

// TrustedMetrics applies TrustedEntries to every class of a metrics object:
// the view every reader must use before a metric reaches an API response, a
// computed row or an LLM prompt (contract 4.1). A class with no surviving
// entry is omitted. A class stored as a single object stays an object; a list
// stays a list of its survivors (even a list of one, so the stored shape of a
// repeated class is preserved). The input is never modified; nil in, an empty
// map out. dropped counts every entry removed.
func TrustedMetrics(metrics map[string]any) (trusted map[string]any, dropped int) {
	trusted = make(map[string]any, len(metrics))
	classes := make([]string, 0, len(metrics))
	for class := range metrics {
		classes = append(classes, class)
	}
	sort.Strings(classes)
	for _, class := range classes {
		v := metrics[class]
		entries, d := TrustedEntries(v)
		dropped += d
		if len(entries) == 0 {
			continue
		}
		if _, single := v.(map[string]any); single {
			trusted[class] = entries[0]
			continue
		}
		list := make([]any, len(entries))
		for i, e := range entries {
			list[i] = e
		}
		trusted[class] = list
	}
	return trusted, dropped
}
