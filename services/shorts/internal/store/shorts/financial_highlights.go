package shorts

import (
	"bytes"
	"encoding/json"
	"sort"
	"strconv"

	"github.com/castlemilk/shorted.com.au/services/pkg/extractiontrust"
)

// parseHighlightMetrics is GetStockFinancialHighlights' read funnel over one
// financial_report_extractions.metrics document (plan
// docs/plans/fundamentals-coverage.md §4.1). Every read of that column applies
// the same trust funnel, from services/pkg/extractiontrust:
//
//   - an entry the extractor could not align to its document, or whose quote
//     is a few-shot example echoed back, is dropped (GroundedEntry; never a
//     value match: CBA's real 1H25 NPAT is also $5,142m);
//   - the provenance keys (alignment, char_start, char_end) are stripped, so
//     they never reach an API response.
//
// A metric's value may be one entry object or an array of them. Attribute
// values that are strings pass through; numbers and booleans are rendered as
// strings (the proto carries map<string, string>); anything else (null, an
// object, an array) is dropped rather than failing the entry. Metric types are
// emitted in sorted order, so the response is stable.
func parseHighlightMetrics(raw []byte) []FinancialMetricEntry {
	var metrics map[string]json.RawMessage
	if err := json.Unmarshal(raw, &metrics); err != nil {
		return nil
	}
	types := make([]string, 0, len(metrics))
	for t := range metrics {
		types = append(types, t)
	}
	sort.Strings(types)

	var out []FinancialMetricEntry
	for _, metricType := range types {
		for _, entry := range decodeMetricEntries(metrics[metricType]) {
			if !extractiontrust.GroundedEntry(entry) {
				continue
			}
			clean := extractiontrust.StripProvenanceEntry(entry)
			sourceText, _ := clean[extractiontrust.KeySourceText].(string)
			delete(clean, extractiontrust.KeySourceText)
			out = append(out, FinancialMetricEntry{
				MetricType: metricType,
				SourceText: sourceText,
				Attributes: stringAttributes(clean),
			})
		}
	}
	return out
}

// decodeMetricEntries reads a metric value as an array of entry objects or a
// single entry object. Anything else yields nothing.
func decodeMetricEntries(raw json.RawMessage) []map[string]any {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return nil
	}
	if raw[0] == '[' {
		var arr []json.RawMessage
		if err := json.Unmarshal(raw, &arr); err != nil {
			return nil
		}
		var out []map[string]any
		for _, item := range arr {
			var entry map[string]any
			if err := json.Unmarshal(item, &entry); err == nil && entry != nil {
				out = append(out, entry)
			}
		}
		return out
	}
	var entry map[string]any
	if err := json.Unmarshal(raw, &entry); err != nil || entry == nil {
		return nil
	}
	return []map[string]any{entry}
}

// stringAttributes renders an entry's attributes as strings (see
// parseHighlightMetrics). nil when none survive.
func stringAttributes(entry map[string]any) map[string]string {
	var out map[string]string
	for k, v := range entry {
		var s string
		switch val := v.(type) {
		case string:
			s = val
		case float64:
			s = strconv.FormatFloat(val, 'f', -1, 64)
		case bool:
			s = strconv.FormatBool(val)
		default:
			continue
		}
		if out == nil {
			out = map[string]string{}
		}
		out[k] = s
	}
	return out
}
