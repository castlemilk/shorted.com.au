package mcp

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
)

// Payload caps. Agents need the shape of the data, not every row: a tool result
// is pasted verbatim into a model's context, so an uncapped list tool spends
// someone's context window on rows nobody reads. Each cap is stated in the
// description of the tool that applies it, so the model knows what it is
// getting rather than mistaking a truncated list for the whole market.
const (
	// defaultPeriod matches the API's own default (SetDefaultValues in the
	// shorts service), so an agent that omits it gets what the website shows.
	defaultPeriod = "1M"

	defaultTopShortsLimit = 20
	defaultTreemapLimit   = 20
	defaultSnapshotLimit  = 25
	defaultSqueezeLimit   = 20
	defaultTradesLimit    = 20
	defaultPeerLimit      = 5
	defaultSearchLimit    = 10
	defaultScreenerLimit  = 20
	defaultNewsLimit      = 10
	defaultReportsLimit   = 12

	// maxSearchLimit is well under the handler's own 100-result cap. Search is a
	// disambiguation step — an agent looking up "the lithium miner" wants a
	// shortlist it can pick from, and fifty near-identical rows make that harder,
	// not easier.
	maxSearchLimit = 25

	// maxScreenerLimit is far below the handler's 4000 (the /directory pages pull
	// the whole universe in one request). A screen is a filtered shortlist for a
	// model to reason over, not a data export.
	maxScreenerLimit = 50

	// maxNewsLimit sits inside ValidateGetStockNewsRequest's 0-100 bound.
	maxNewsLimit = 30

	// maxReportsLimit sits inside ListReports' own 500 ceiling. Fifty covers
	// roughly a year of weeklies plus the monthlies and yearlies around them.
	maxReportsLimit = 50

	// maxListLimit is the hard ceiling shared by every list-shaped tool.
	//
	// Every ceiling here sits INSIDE the bound the corresponding handler's own
	// validator enforces (GetTopShorts and GetMarketByDate 1000, GetIndustry-
	// TreeMap 500, GetDirectorTrades 200, GetBattlegroundStocks 100), so a
	// clamped limit is never an InvalidArgument round trip. Raising one of
	// these past its handler's bound turns a clamp into an error — check
	// validation.go in the shorts service first.
	maxListLimit = 100

	// maxPeerLimit is lower because peers are only useful as a short comparison
	// set — twenty industry neighbours is past the point of insight. It is also
	// exactly the bound ValidateGetPeerComparisonRequest enforces.
	maxPeerLimit = 20

	// maxHistoryPoints mirrors MAX_POINTS in the legacy Next.js MCP route
	// (web/src/app/api/mcp/[transport]/route.ts), so the two surfaces
	// downsample identically. A MAX-period series is ~2,500 daily observations.
	maxHistoryPoints = 200

	// maxTreemapStocks caps the flattened industry/stock pairs. The RPC will
	// return up to 500.
	maxTreemapStocks = 150

	// maxProseChars bounds each free-text field on get_stock_details. Enriched
	// summaries and company histories run to several thousand characters each,
	// and there are five of them on one message.
	maxProseChars = 1200

	// maxListItems bounds repeated string/struct fields (risk factors, key
	// people) on get_stock_details.
	maxListItems = 10

	// maxNewsSummaryChars bounds each article summary on get_stock_news. Summaries
	// run to a few hundred characters; at thirty articles the difference between
	// bounded and unbounded is the whole payload budget.
	maxNewsSummaryChars = 400

	// maxHeadlineChars bounds a report headline. Generated headlines are
	// normally one line; the cap exists because nothing upstream enforces it.
	maxHeadlineChars = 200
	// maxReportStandfirstChars bounds get_report's own summary. Larger than the
	// list_reports standfirst because a single report can afford more, small
	// enough that the tool stays inside its 16KB budget.
	maxReportStandfirstChars = 700
	// maxReportSummaryChars bounds the standfirst on each list_reports row.
	maxReportSummaryChars = 320

	// maxNarrativeChars bounds each of get_report's five narrative sections. A
	// full weekly narrative is several thousand characters per section and the
	// five together would exceed the whole per-call budget on their own.
	maxNarrativeChars = 800

	// maxReportStocks / maxReportMovers / maxReportIndustries / maxReportCitations
	// bound get_report's repeated sections. The report itself carries far more —
	// these are the head of each list, which is what a briefing needs.
	maxReportStocks     = 10
	maxReportMovers     = 5
	maxReportIndustries = 10
	maxReportCitations  = 10

	// truncationMarker is appended to any field cut short, so the agent can
	// tell a deliberate excerpt from a sentence that simply ends.
	truncationMarker = "… [truncated]"
)

// asxCodeRe mirrors stockCodeRegex in the shorts service's validation.go. The
// handler validates too, but doing it here turns "9ZZZZ" into a clear tool
// error instead of a Connect InvalidArgument the model has to decode.
var asxCodeRe = regexp.MustCompile(`^[A-Z0-9]{3,4}$`)

// isoDateRe is the format GetMarketByDate requires. Matching it here means an
// agent that passes "1 August 2026" gets told the format rather than an
// InvalidArgument.
var isoDateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// validPeriods mirrors the same map in the shorts service's validation.go.
// Duplicated rather than imported because that package imports this one's
// consumer; a drift here surfaces as a confusing InvalidArgument from the
// handler, not silent wrong data.
var validPeriods = []string{"1D", "1W", "1M", "3M", "6M", "1Y", "2Y", "5Y", "10Y", "MAX"}

// periodList is the human-readable form used in tool descriptions and errors,
// derived from validPeriods so the two cannot disagree.
var periodList = strings.Join(validPeriods, ", ")

// normaliseCode upper-cases and validates an ASX ticker, returning an error the
// model can act on rather than one it has to decode.
func normaliseCode(raw string) (string, error) {
	code := strings.ToUpper(strings.TrimSpace(raw))
	if !asxCodeRe.MatchString(code) {
		return "", fmt.Errorf(
			"%q is not a valid ASX ticker code: expected 3-4 alphanumeric characters, e.g. BHP", raw)
	}
	return code, nil
}

// normalisePeriod upper-cases and validates a lookback window, defaulting when
// the caller omits it.
func normalisePeriod(raw string) (string, error) {
	period := strings.ToUpper(strings.TrimSpace(raw))
	if period == "" {
		return defaultPeriod, nil
	}
	for _, valid := range validPeriods {
		if period == valid {
			return period, nil
		}
	}
	return "", fmt.Errorf("%q is not a valid period: use one of %s", raw, periodList)
}

// clampLimit applies the tool's default when the caller omits a limit and its
// ceiling when the caller asks for too much. Over-asking is clamped rather than
// rejected: an agent that guesses 500 should get 100 rows, not an error round
// trip. A negative limit is nonsense and takes the default.
func clampLimit(requested, fallback, max int) int32 {
	if requested <= 0 {
		return int32(fallback)
	}
	if requested > max {
		return int32(max)
	}
	return int32(requested)
}

// downsample returns at most max evenly-spaced items from in, always including
// the first and the last. The final observation is the one a reader cares about
// most, and a plain every-Nth filter drops it whenever the stride does not
// divide the length evenly.
func downsample[T any](in []T, max int) []T {
	if len(in) <= max || max <= 0 {
		return in
	}
	step := (len(in) + max - 1) / max
	out := make([]T, 0, max+1)
	for i := 0; i < len(in); i += step {
		out = append(out, in[i])
	}
	if (len(in)-1)%step != 0 {
		out = append(out, in[len(in)-1])
	}
	// Keeping both endpoints can push the result to max+1: the strided walk
	// can already have produced exactly max items before the final append.
	// The schema and the tool description both promise "at most max", so
	// overwrite the last strided sample with the true endpoint rather than
	// return a series one longer than advertised.
	if len(out) > max {
		out[len(out)-2] = out[len(out)-1]
		out = out[:len(out)-1]
	}
	return out
}

// truncate bounds a free-text field, marking it so an excerpt is never mistaken
// for the whole value. It cuts on a rune boundary.
func truncate(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return strings.TrimRight(string(runes[:max]), " ") + truncationMarker
}

// firstNonEmpty returns the first non-blank string, used where the proto offers
// an enriched field and a base one for the same fact.
func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func nonEmpty(s, fallback string) string {
	if strings.TrimSpace(s) == "" {
		return fallback
	}
	return s
}

// fromFloat32 widens a float32 proto field to float64 without dragging the
// binary32 representation error into the JSON. A plain float64(x) turns a
// stored 19.43 into 19.430000305175781, which is both wrong-looking to a reader
// and four times the bytes. Four decimal places is finer than any short
// position is meaningful to.
func fromFloat32(v float32) float64 {
	return math.Round(float64(v)*10_000) / 10_000
}

// contains reports membership of a small fixed set of allowed values.
func contains(set []string, value string) bool {
	for _, v := range set {
		if v == value {
			return true
		}
	}
	return false
}

// sortedKeys returns a map's keys in a stable order, so an error message that
// lists the valid values reads the same on every call.
func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// trimmedNonEmpty drops blank entries from a caller-supplied string list, so a
// stray "" cannot become a filter that matches nothing.
func trimmedNonEmpty(in []string) []string {
	out := make([]string, 0, len(in))
	for _, v := range in {
		if trimmed := strings.TrimSpace(v); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// capitalise upper-cases the first letter of an ASCII word. strings.Title is
// deprecated and golang.org/x/text/cases is a dependency for one word.
func capitalise(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// capItems bounds a repeated field.
func capItems[T any](in []T, max int) []T {
	if len(in) <= max {
		return in
	}
	return in[:max]
}

// asicCaveat is appended to the text fallback of every tool whose numbers come
// from the ASIC short position report, so the delay travels with the figure
// rather than living only in the tool description the model may not re-read.
const asicCaveat = " Source: ASIC short position report, published T+4 business days."
