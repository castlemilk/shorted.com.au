package picks

import (
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/castlemilk/shorted.com.au/services/pkg/extractiontrust"
)

// Reading one metric's value out of its own quote (-mode filings). A value is
// taken only when it can be FOUND in its source_text in a unit the text (or,
// for a bare table figure, the document's own unit statement) makes
// unambiguous. Nothing here guesses; every failure has a reason the run tally
// counts.

var (
	// A number in text: optional sign or parenthesis, digits with thousands
	// separators, optional decimals.
	numberRe = regexp.MustCompile(`\(?-?\d[\d,]*(?:\.\d+)?\)?`)
	// Scale words directly after a number.
	scaleRe = regexp.MustCompile(`(?i)^\s*(billion|bn|b|million|mn|mill|m|thousand|k|'000|000s)\b`)
	// Table-heading markers that say bare numbers are millions / thousands.
	millionsMarkerRe  = regexp.MustCompile(`(?i)\$\s?m\b|\$\s?million\b|\(\s?\$?m\s?\)|\$'?m\b|\bm\$|\bin millions\b`)
	thousandsMarkerRe = regexp.MustCompile(`(?i)\$\s?'?000\b|\$000s?\b|\bin thousands\b|\(\s?\$?'000\s?\)`)

	// nonStatutoryRe is gate 5 (plan fundamentals-coverage.md §4.2): a quote
	// naming a non-statutory, partial or pre-tax figure is not the company's
	// statutory revenue, NPAT or EPS. Measured on prod 2026-09-28: BHP's
	// "Profit from operations" (US$19.5bn) stored as NPAT; EDV, GYG, DMP and
	// FLT channel, network, segment and TTV figures stored as revenue.
	nonStatutoryRe = regexp.MustCompile(`(?i)` +
		`\bunderlying\b|\bnormali[sz]ed\b|\badjusted\b|\bpro[- ]?forma\b|` +
		`\bebitda\b|\bebit\b|\bsegment(?:s|al)?\b|\bdivision(?:s|al)?\b|\bexcluding\b|` +
		`\bgross profit\b|\bother income\b|\binterest (?:income|revenue)\b|\bcash receipts\b|` +
		`\bprofit from operations\b|\boperating profit\b|\bprofit before (?:income )?tax(?:ation)?\b|` +
		`\bcash (?:npat|earnings|eps)\b|\btotal comprehensive income\b|` +
		`\b(?:network|online|channel) sales\b|\btotal transaction value\b|\bttv\b`)

	lossRe   = regexp.MustCompile(`(?i)\bloss\b`)
	profitRe = regexp.MustCompile(`(?i)\bprofit\b`)
)

// statutory reports whether a quote passes gate 5.
func statutory(text string) bool { return !nonStatutoryRe.MatchString(text) }

// textNumber is one number found in a quote, with what surrounds it.
type textNumber struct {
	value    float64
	negative bool   // parenthesised or signed
	dollar   bool   // preceded by $ (A$, US$, ...)
	scale    string // billion | million | thousand | ""
	after    string // the text right after it (lower case, for unit words)
	digits   int    // integer digits, separators excluded
	pos      int    // byte offset in the quote
}

func findNumbers(text string) []textNumber {
	var out []textNumber
	for _, loc := range numberRe.FindAllStringIndex(text, -1) {
		raw := text[loc[0]:loc[1]]
		neg := strings.HasPrefix(raw, "(") && strings.HasSuffix(raw, ")") || strings.HasPrefix(strings.TrimPrefix(raw, "("), "-")
		clean := strings.NewReplacer("(", "", ")", "", ",", "", "-", "").Replace(raw)
		v, err := strconv.ParseFloat(clean, 64)
		if err != nil {
			continue
		}
		intPart := clean
		if i := strings.IndexByte(clean, '.'); i >= 0 {
			intPart = clean[:i]
		}
		n := textNumber{value: v, negative: neg, digits: len(strings.TrimLeft(intPart, "0")), pos: loc[0]}
		before := strings.TrimRight(text[:loc[0]], " ")
		n.dollar = strings.HasSuffix(before, "$")
		rest := text[loc[1]:]
		if m := scaleRe.FindStringSubmatch(rest); m != nil {
			switch strings.ToLower(m[1]) {
			case "billion", "bn", "b":
				n.scale = "billion"
			case "million", "mn", "mill", "m":
				n.scale = "million"
			default:
				n.scale = "thousand"
			}
		}
		if len(rest) > 40 {
			rest = rest[:40]
		}
		n.after = strings.ToLower(rest)
		out = append(out, n)
	}
	return out
}

// parseAttrNumber reads a numeric attribute ("5,142", "-3.2", "(3.2)", 94.2).
func parseAttrNumber(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	neg := strings.HasPrefix(s, "(") && strings.HasSuffix(s, ")")
	s = strings.NewReplacer("(", "", ")", "", ",", "", "$", "", " ", "", "+", "").Replace(s)
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, false
	}
	if neg {
		v = -math.Abs(v)
	}
	return v, true
}

// filingMoney reads revenue / net profit: value_millions, verified against
// the quote's own number and scale, returned in whole currency units.
//
// A number's scale comes from, in order: a scale word right after it
// ("$45.2 million", "$1.2bn"); for a BARE table figure (no "$", no scale
// word, no heading in the quote), the document's own unit statement (docUnits
// = document_meta.units: the 4D/4E summary tables' "US$ Million" header,
// which the quoted table line does not repeat; plan §4.2's last paragraph);
// seven or more integer digits with no thousands heading (whole units:
// "$45,213,000"); a table heading in the quote ("($m)", "$'000"). A figure
// none of these scales is skipped: the same digits are millions in one table
// and thousands in the next.
func filingMoney(entry map[string]any, col, docUnits string) (float64, string, bool) {
	text := attrString(entry, "source_text")
	if text == "" {
		return 0, "no source text", false
	}
	if !statutory(text) {
		return 0, "not a statutory figure", false
	}
	mill, ok := parseAttrNumber(attrString(entry, "value_millions"))
	if !ok {
		return 0, "no value_millions", false
	}
	millionsTable := millionsMarkerRe.MatchString(text)
	thousandsTable := thousandsMarkerRe.MatchString(text)
	docScale, hasDocScale := extractiontrust.DocumentMeta{Units: docUnits}.UnitsMultiplier()
	found, negative := false, false
	for _, n := range findNumbers(text) {
		var interp []float64
		switch n.scale {
		case "billion":
			interp = []float64{n.value * 1000}
		case "million":
			interp = []float64{n.value}
		case "thousand":
			interp = []float64{n.value / 1000}
		default:
			switch {
			case !n.dollar && hasDocScale && !millionsTable && !thousandsTable:
				// A bare table figure (no $, no scale word, no heading in
				// the quote) under the document's one unit statement.
				interp = []float64{n.value * docScale / 1e6}
			case n.digits >= 7 && !thousandsTable:
				interp = []float64{n.value / 1e6} // whole units: 45,213,000
			case millionsTable && !thousandsTable:
				interp = []float64{n.value}
			case thousandsTable && !millionsTable:
				interp = []float64{n.value / 1000}
			}
		}
		for _, v := range interp {
			if v != 0 && approxEqual(v, math.Abs(mill)) {
				found = true
				negative = n.negative
			}
		}
		if found {
			break
		}
	}
	if !found {
		return 0, "value not found in its quote with an unambiguous scale", false
	}
	v := math.Abs(mill) * 1e6
	switch col {
	case "revenue":
		if mill < 0 || negative {
			return 0, "negative revenue", false
		}
	case "net_income":
		loss := mill < 0 || negative || (lossRe.MatchString(text) && !profitRe.MatchString(text))
		if loss {
			v = -v
		}
	}
	return v, "", true
}

// epsReading is one EPS in dollars per share and the columns it belongs to.
type epsReading struct {
	dollars float64
	cols    []string // eps_basic and/or eps_diluted
}

var (
	centsAfterRe     = regexp.MustCompile(`^\s*(?:c\b|¢|cents?\b|cps\b|cent\b|us\s?cents?\b|us\s?c\b)`)
	centsAnywhereRe  = regexp.MustCompile(`(?i)\bcents?\b|\bcps\b|¢`)
	dilutedRe        = regexp.MustCompile(`(?i)\bdiluted\b`)
	bothEPSRe        = regexp.MustCompile(`(?i)\bbasic\s*(?:and|&|/)\s*diluted\b|\bdiluted\s*(?:and|&|/)\s*basic\b`)
	basicRe          = regexp.MustCompile(`(?i)\bbasic\b`)
	lossPerShareRe   = regexp.MustCompile(`(?i)\bloss(?:es)?\s+per\s+share\b|\bnegative\b`)
	maxPlausibleEPS  = 1000.0 // dollars per share
	epsDollarKeys    = []string{"value_dollars", "value_aud", "value_per_share"}
	epsCentsKeys     = []string{"value_cents", "value_cps"}
	epsUnitlessKeys  = []string{"value"}
	epsAnyValueOrder = append(append(append([]string{}, epsCentsKeys...), epsDollarKeys...), epsUnitlessKeys...)
)

// filingEPS reads an EPS entry. The unit comes from the text around the
// value's own number: cents when followed by c / cents / cps / ¢, dollars
// when written $x with no scale. No unit next to the number: "cents" elsewhere
// in the quote, else the attribute's name. Anything else is skipped. The
// document's unit statement never applies to a per-share figure.
func filingEPS(entry map[string]any) (epsReading, string, bool) {
	text := attrString(entry, "source_text")
	if text == "" {
		return epsReading{}, "no source text", false
	}
	if !statutory(text) {
		return epsReading{}, "not a statutory figure", false
	}
	key, raw := "", ""
	for _, k := range epsAnyValueOrder {
		if s := attrString(entry, k); s != "" {
			key, raw = k, s
			break
		}
	}
	if raw == "" {
		return epsReading{}, "no EPS value (or only value_millions)", false
	}
	v, ok := parseAttrNumber(raw)
	if !ok {
		return epsReading{}, "unparseable EPS value", false
	}

	var match *textNumber
	for _, n := range findNumbers(text) {
		if sameNumber(n.value, math.Abs(v)) && n.scale == "" {
			n := n
			match = &n
			break
		}
	}
	if match == nil {
		return epsReading{}, "EPS value not found in its quote", false
	}
	unit := ""
	switch {
	case centsAfterRe.MatchString(match.after) && match.dollar:
		return epsReading{}, "EPS written as both $ and cents", false
	case centsAfterRe.MatchString(match.after):
		unit = "cents"
	case match.dollar:
		unit = "dollars"
	case centsAnywhereRe.MatchString(text):
		unit = "cents"
	case containsKey(epsCentsKeys, key):
		unit = "cents"
	case containsKey(epsDollarKeys, key):
		unit = "dollars"
	default:
		return epsReading{}, "EPS unit ambiguous (cents or dollars)", false
	}
	dollars := math.Abs(v)
	if unit == "cents" {
		dollars /= 100
	}
	if v < 0 || match.negative || lossPerShareRe.MatchString(text) {
		dollars = -dollars
	}
	if math.Abs(dollars) > maxPlausibleEPS {
		return epsReading{}, "implausible EPS", false
	}
	return epsReading{dollars: dollars, cols: epsColumns(text, match.pos)}, "", true
}

// epsColumns decides basic vs diluted: "basic and diluted" (either order, or
// "basic/diluted") is both; otherwise the qualifier nearest BEFORE the number
// ("Basic EPS 94.2c, diluted 93.8c" gives 94.2 to basic); no qualifier is
// basic, the Appendix 4D/4E default.
func epsColumns(text string, pos int) []string {
	if bothEPSRe.MatchString(text) {
		return []string{"eps_basic", "eps_diluted"}
	}
	before := text[:pos]
	b := lastIndex(basicRe, before)
	d := lastIndex(dilutedRe, before)
	if d > b {
		return []string{"eps_diluted"}
	}
	if b < 0 && d < 0 && dilutedRe.MatchString(text) && !basicRe.MatchString(text) {
		return []string{"eps_diluted"} // "... 93.8 cents (diluted)"
	}
	return []string{"eps_basic"}
}

func lastIndex(rx *regexp.Regexp, s string) int {
	locs := rx.FindAllStringIndex(s, -1)
	if len(locs) == 0 {
		return -1
	}
	return locs[len(locs)-1][0]
}

func containsKey(keys []string, k string) bool {
	for _, x := range keys {
		if x == k {
			return true
		}
	}
	return false
}

var currencyMarkers = []struct {
	code string
	rx   *regexp.Regexp
}{
	{"USD", regexp.MustCompile(`(?i)\bUS\s?\$|\bUSD\b|\bUS\s?dollars?\b|\bUS\s?cents?\b|\bUSc\b`)},
	{"NZD", regexp.MustCompile(`(?i)\bNZ\s?\$|\bNZD\b|\bNZ\s?cents?\b`)},
	{"GBP", regexp.MustCompile(`£|\bGBP\b|\bpence\b`)},
	{"EUR", regexp.MustCompile(`€|\bEUR\b`)},
	{"CAD", regexp.MustCompile(`\bC\$|\bCAD\b`)},
	{"AUD", regexp.MustCompile(`\bA\$|\bAUD\b|\bAU\$`)},
}

// textCurrency is the quote's currency: an explicit marker (US$, USD, US
// cents, NZ$, £, €, C$, A$), else def. Two different markers in one quote is
// ambiguous (ok=false). A bare "$" is never a marker: BHP's own 4E writes "$"
// for US dollars.
func textCurrency(text, def string) (string, bool) {
	found := ""
	for _, m := range currencyMarkers {
		if m.rx.MatchString(text) {
			if found != "" && found != m.code {
				return "", false
			}
			found = m.code
		}
	}
	if found != "" {
		return found, true
	}
	return def, true
}
