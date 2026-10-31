package mcp

// admin_crawl_text.go: the pure helpers the housing crawl debugging tools share. Nothing
// here touches the network or the database.
//
//   - redactText strips what a listing can leak from log and error text: URLs, e-mail
//     addresses, prices, Australian phone numbers and street addresses. It is a
//     best-effort guard on operator output, not a privacy boundary: the tools that
//     return log text are for administrators only.
//   - classifyCrawlFailure maps a BrandBrain job's error text and result summary to one
//     of the closed failure classes. It reads the STRING values of a result summary only,
//     never its keys, because a count named "blocked" must not read as a block.
//   - sanitizeValue reduces a value of unknown shape (the rig's alarm) to closed values:
//     bools, numbers, enum-shaped names and RFC 3339 timestamps. Free text is dropped.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// The failure classes a BrandBrain failed or deferred job is grouped into. The set is
// closed: an unmatched message is "other", never a new class.
const (
	FailureNotDispatched     = "not_dispatched"
	FailureDispatchExpired   = "dispatch_expired"
	FailureTargetMismatch    = "target_mismatch"
	FailureBlocked           = "blocked"
	FailureCircuitOpen       = "circuit_open"
	FailureChrome            = "chrome"
	FailureTimeout           = "timeout"
	FailureIngestUnavailable = "ingest_unavailable"
	FailureOther             = "other"
)

// FailureClasses is every class, in the order the tools report them.
var FailureClasses = []string{FailureNotDispatched, FailureDispatchExpired, FailureTargetMismatch,
	FailureBlocked, FailureCircuitOpen, FailureChrome, FailureTimeout, FailureIngestUnavailable, FailureOther}

var (
	redactURL   = regexp.MustCompile(`(?i)\b(?:https?|ftp)://\S+`)
	redactEmail = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`)
	redactPrice = regexp.MustCompile(`\$\s?[0-9][0-9,]*(?:\.[0-9]+)?\s?[kKmMbB]?`)
	redactPhone = regexp.MustCompile(`(?:\+?61|\b0)[2-9](?:[ -]?[0-9]){7,9}\b`)
	// redactAddress is a street address: a number, up to three words, then a street type.
	redactAddress = regexp.MustCompile(`(?i)\b[0-9]+[a-z]?(?:/[0-9]+[a-z]?)?\s+(?:[A-Za-z'-]+\s+){1,3}(?:` + streetTypes + `)\b\.?`)
	// redactSlugAddress is a catalog-style address key: street words, the state and a postcode,
	// as the collector writes them in its log keys (12-smith-street-bondi-nsw-2026).
	redactSlugAddress = regexp.MustCompile(`(?i)\b[a-z0-9]+(?:-[a-z0-9]+){2,}-(?:nsw|vic|qld|sa|wa|tas|nt|act)-[0-9]{4}\b`)
	// closedName is a lower-case enum-shaped word: what the fleet and the ledger use for
	// states, phases, reasons and statuses.
	closedName = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)
	// closedVersion is a release version as the agent reports it: 1.21.0, 1.40.0-rc1.
	versionPattern = regexp.MustCompile(`^[0-9]{1,4}(?:\.[0-9]{1,4}){1,3}(?:-[A-Za-z0-9.]{1,24})?$`)
)

// streetTypes are the street words an address line can end in. Redaction is conservative, so a
// longer list only over-redacts.
const streetTypes = `street|st|road|rd|avenue|ave|av|drive|dr|place|pl|court|ct|crescent|cres|lane|ln|way|terrace|tce|boulevard|blvd|parade|pde|close|cl|highway|hwy|grove|gr|circuit|cct|esplanade|esp|rise|square|sq|loop|mews|walk|trail|track|quay|promenade|ridge|vista|crest|gardens|gdns|parkway|pwy|row|mall`

// maxErrorText is the longest error or log text a tool returns for one item.
const maxErrorText = 300

// redactText removes URLs, e-mail addresses, prices, phone numbers and street addresses, in that
// order, and trims the result. Each removal leaves a marker so a reader can see that something was
// there. It is applied to text that is kept; a line that carries listing data is dropped whole by
// keepLogLine before it reaches here.
func redactText(s string) string {
	s = redactURL.ReplaceAllString(s, "[url]")
	s = redactEmail.ReplaceAllString(s, "[email]")
	s = redactPrice.ReplaceAllString(s, "[price]")
	s = redactSlugAddress.ReplaceAllString(s, "[address]")
	s = redactAddress.ReplaceAllString(s, "[address]")
	s = redactPhone.ReplaceAllString(s, "[phone]")
	return strings.TrimSpace(s)
}

// keepLogLine reports whether a rig log line may leave at all. Two collector prefixes carry listing
// data by design, so the whole line is dropped rather than redacted: the per-suburb DRY listing
// rows ("[listings] DRY ..." carries a price, an address and a listing URL) and the property
// per-address keys ("[property] <slug-address>: ..."). Redaction is best effort; dropping is exact.
func keepLogLine(line string) bool {
	l := strings.TrimSpace(line)
	if strings.HasPrefix(l, "[listings] DRY") {
		return false
	}
	if rest, ok := strings.CutPrefix(l, "[property] "); ok && redactSlugAddress.MatchString(rest) {
		return false
	}
	return true
}

// boundedText redacts and caps one error or log text.
func boundedText(s string) string {
	return truncateRunes(redactText(s), maxErrorText)
}

// truncateRunes caps s at n bytes, never splitting a UTF-8 sequence, and marks the cut.
func truncateRunes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "…"
}

// stringLeaves returns every string VALUE in a JSON document, joined by spaces. Keys and
// numbers are not included.
func stringLeaves(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return ""
	}
	var parts []string
	var walk func(any)
	walk = func(x any) {
		switch t := x.(type) {
		case string:
			parts = append(parts, t)
		case []any:
			for _, e := range t {
				walk(e)
			}
		case map[string]any:
			for _, e := range t {
				walk(e)
			}
		}
	}
	walk(v)
	return strings.Join(parts, " ")
}

// classifyCrawlFailure returns the failure class for a job from its error text and result
// summary. BrandBrain redacts the text (URLs, e-mail addresses and paths are stripped) and
// caps it at about 512 bytes, so the match is on stable words, not on anything a redaction
// could remove. Two counters in the summary are read as well:
//
//   - blocked_sweeps > 0 is a block, whatever the text says;
//   - needs_rewarm (a count, or true) means the browser session needs warming again, which
//     is a Chrome failure.
//
// The order is the order of specificity: a circuit before the block it causes.
func classifyCrawlFailure(message string, summary json.RawMessage) string {
	text := strings.ToLower(message + " " + stringLeaves(summary))
	has := func(words ...string) bool {
		for _, w := range words {
			if strings.Contains(text, w) {
				return true
			}
		}
		return false
	}
	counters := summaryCounters(summary)
	switch {
	case has("not dispatched", "not_dispatched"):
		return FailureNotDispatched
	case has("dispatch expired", "dispatch_expired"):
		return FailureDispatchExpired
	case has("target mismatch", "target_mismatch"):
		return FailureTargetMismatch
	case has("circuit open", "circuit_open"):
		return FailureCircuitOpen
	case has("blocked") || counters["blocked_sweeps"] > 0:
		return FailureBlocked
	case has("chrome") || counters["needs_rewarm"] > 0:
		return FailureChrome
	case has("timeout", "timed out", "deadline exceeded"):
		return FailureTimeout
	case has("ingest unavailable", "ingest_unavailable"):
		return FailureIngestUnavailable
	default:
		return FailureOther
	}
}

// summaryCounters reads the numeric top-level counters the classifier uses. A boolean true
// counts as 1, so needs_rewarm: true and needs_rewarm: 1 agree. Other values are absent.
func summaryCounters(raw json.RawMessage) map[string]float64 {
	out := map[string]float64{}
	if len(raw) == 0 {
		return out
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return out
	}
	for _, key := range []string{"blocked_sweeps", "needs_rewarm"} {
		switch v := m[key].(type) {
		case float64:
			out[key] = v
		case bool:
			if v {
				out[key] = 1
			}
		}
	}
	return out
}

// receiptStatusName turns a stored applied status (SWEEP_STATUS_COMPLETE) into the word the
// tools return (complete). An unknown value reads as "".
func receiptStatusName(s string) string {
	return closedValue(strings.ToLower(strings.TrimPrefix(s, "SWEEP_STATUS_")))
}

// closedValue passes a fleet enum through when it is a lower-case word, and returns ""
// otherwise. An unexpected string never reaches the model.
func closedValue(s string) string {
	if closedName.MatchString(s) {
		return s
	}
	return ""
}

// sanitizeValue reduces a value of unknown shape to closed values: bools, numbers,
// enum-shaped keys and values, and RFC 3339 timestamps. Any other string is dropped.
func sanitizeValue(v any) any {
	switch t := v.(type) {
	case bool, float64:
		return t
	case string:
		if closedName.MatchString(t) {
			return t
		}
		if _, err := time.Parse(time.RFC3339, t); err == nil {
			return t
		}
		return nil
	case []any:
		out := make([]any, 0, len(t))
		for _, e := range t {
			if s := sanitizeValue(e); s != nil {
				out = append(out, s)
			}
		}
		return out
	case map[string]any:
		out := map[string]any{}
		for k, e := range t {
			if !closedName.MatchString(k) {
				continue
			}
			if s := sanitizeValue(e); s != nil {
				out[k] = s
			}
		}
		return out
	default:
		return nil
	}
}

// rfc3339 formats an optional instant, or "" when it is absent.
func rfc3339(t *time.Time) string {
	if t == nil || t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// randomHex returns n random bytes as 2n lower-case hex digits.
func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// closedVersion passes a release version through (1.21.0, 128.0.6613.120) and returns "" for
// anything else. A version is not an enum, so closedValue would blank it.
func closedVersion(s string) string {
	if versionPattern.MatchString(s) {
		return s
	}
	return ""
}
