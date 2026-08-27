package mcp

import (
	"fmt"
	"regexp"
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
