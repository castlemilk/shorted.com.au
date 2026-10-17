package extractiontrust

import "strings"

// Keys the extractor writes into each stored metric entry. The provenance keys
// are the extractor's alignment bookkeeping (contract 6.1): string attributes
// holding langextract's alignment_status value and the aligned span's
// character offsets.
const (
	KeySourceText = "source_text"
	KeyAlignment  = "alignment"
	KeyCharStart  = "char_start"
	KeyCharEnd    = "char_end"
)

// alignedStatuses are the langextract alignment_status values that mean the
// extraction was found in the document. Anything else (missing is handled
// separately) means it was not: "", "unaligned", None rendered as a string, an
// enum's repr, a number.
var alignedStatuses = map[string]bool{
	"match_exact":   true,
	"match_greater": true,
	"match_lesser":  true,
	"match_fuzzy":   true,
}

// Grounded reports whether a stored metric entry may be trusted (contract 4.1,
// gates 2 and 3). attrs are the entry's attributes (with or without
// source_text; only "alignment" is read from it) and sourceText is its quote.
//
//   - An entry carrying "alignment" whose value is not one of match_exact,
//     match_greater, match_lesser, match_fuzzy is NOT grounded: the extractor
//     could not find it in the document.
//   - An entry whose quote is a few-shot example text (IsFewShotText, old or
//     new) is NOT grounded: the model echoed its prompt.
//   - Otherwise it is grounded. Legacy entries written before the extractor
//     recorded alignment have no "alignment" key and pass this gate; the
//     few-shot denylist and the ingest's own gates still apply to them.
//
// Never a value match: CBA's real "Statutory NPAT2 $5,142m" is grounded.
func Grounded(attrs map[string]string, sourceText string) bool {
	if a, ok := attrs[KeyAlignment]; ok && !alignedStatuses[strings.TrimSpace(a)] {
		return false
	}
	return !IsFewShotText(sourceText)
}

// GroundedEntry is Grounded for an entry decoded as map[string]any (the shape
// the picks filings ingest and the digest prompt use). The quote is the entry's
// "source_text" when it is a string. A present "alignment" that is not a string
// (null, a number) is not grounded.
func GroundedEntry(entry map[string]any) bool {
	if raw, ok := entry[KeyAlignment]; ok {
		s, isString := raw.(string)
		if !isString || !alignedStatuses[strings.TrimSpace(s)] {
			return false
		}
	}
	text, _ := entry[KeySourceText].(string)
	return !IsFewShotText(text)
}

// IsProvenanceKey reports whether k is extractor bookkeeping that must never
// reach an API response or an LLM prompt: alignment, char_start, char_end.
func IsProvenanceKey(k string) bool {
	switch k {
	case KeyAlignment, KeyCharStart, KeyCharEnd:
		return true
	}
	return false
}

// StripProvenance returns a copy of attrs without the provenance keys. The input
// is never modified. nil in, nil out.
func StripProvenance(attrs map[string]string) map[string]string {
	if attrs == nil {
		return nil
	}
	out := make(map[string]string, len(attrs))
	for k, v := range attrs {
		if !IsProvenanceKey(k) {
			out[k] = v
		}
	}
	return out
}

// StripProvenanceEntry is StripProvenance for an entry decoded as
// map[string]any. The input is never modified. nil in, nil out.
func StripProvenanceEntry(entry map[string]any) map[string]any {
	if entry == nil {
		return nil
	}
	out := make(map[string]any, len(entry))
	for k, v := range entry {
		if !IsProvenanceKey(k) {
			out[k] = v
		}
	}
	return out
}
