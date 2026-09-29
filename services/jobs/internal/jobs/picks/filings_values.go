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
	scaleRe = regexp.MustCompile(`(?i)^\s*(billion|bn|b|million|mn|mill|m|thousand|k|['’]000|000s)\b`)
	// Table-heading markers that say bare numbers are millions / thousands.
	// ['’]: PDF text layers carry the typographic apostrophe ("$’000") as
	// often as the ASCII one; missing it withheld every figure in such tables.
	millionsMarkerRe  = regexp.MustCompile(`(?i)\$\s?m\b|\$\s?million\b|\(\s?\$?m\s?\)|\$['’]?m\b|\bm\$|\bin millions\b`)
	thousandsMarkerRe = regexp.MustCompile(`(?i)\$\s?['’]?000\b|\$000s?\b|\bin thousands\b|\(\s?\$?['’]000\s?\)`)

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

	// Accounting negatives around a money figure: the figure wrapped in
	// parentheses with its currency and scale ("($3.2m)", "(US$3.2
	// million)", "(2.1c)"), or a minus in front of its currency ("-$3.2m",
	// "−3.2" with U+2212).
	wrapOpenRe    = regexp.MustCompile(`\(\s*` + currencyPrefix + `\$\s*$`)
	wrapCloseRe   = regexp.MustCompile(`(?i)^\s*(?:(?:billion|bn|b|million|mn|mill|m|thousand|k|cents?|c|cps)\b|¢)?\.?\s*\)`)
	minusBeforeRe = regexp.MustCompile(`(?:^|[\s(:])(?:[-\x{2212}]` + currencyPrefix + `\$|\x{2212})\s*$`)
	// thousandsSepRe: a thousands separator inside a number ("45,213").
	thousandsSepRe = regexp.MustCompile(`\d,\d`)
)

// currencyPrefix: the letters a dollar sign may carry (A$, AU$, US$, NZ$,
// C$, HK$, S$).
const currencyPrefix = `(?:A|AU|US|NZ|C|HK|S)?\s?`

// reasonSignAmbiguous: the quote's words, or its words and the value
// attribute, give the figure both a loss and a profit sign. Counted at gate 5
// (gateSignAmbiguous) and withheld.
const reasonSignAmbiguous = "sign ambiguous"

// statutory reports whether a quote passes gate 5.
func statutory(text string) bool { return !nonStatutoryRe.MatchString(text) }

// textNumber is one number found in a quote, with what surrounds it.
type textNumber struct {
	value float64
	// negative: the number carries its own sign: a minus, parentheses around
	// the digits ("(12.3)") or around the whole money figure ("($3.2m)").
	negative bool
	dollar   bool   // preceded by $ (A$, US$, ...)
	scale    string // billion | million | thousand | ""
	after    string // the text right after it (lower case, for unit words)
	digits   int    // integer digits, separators excluded
	pos      int    // byte offset in the quote
	end      int    // byte offset just past the number
	// amount: the number reads as an amount rather than a date, a year or a
	// label digit: a currency sign, a scale word, a cents unit, a percent,
	// decimals or a thousands separator. It ends a comparison's scope.
	amount bool
}

func findNumbers(text string) []textNumber {
	var out []textNumber
	for _, loc := range numberRe.FindAllStringIndex(text, -1) {
		raw := text[loc[0]:loc[1]]
		clean := strings.NewReplacer("(", "", ")", "", ",", "", "-", "").Replace(raw)
		v, err := strconv.ParseFloat(clean, 64)
		if err != nil {
			continue
		}
		intPart := clean
		if i := strings.IndexByte(clean, '.'); i >= 0 {
			intPart = clean[:i]
		}
		n := textNumber{value: v, digits: len(strings.TrimLeft(intPart, "0")), pos: loc[0], end: loc[1]}
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
		opened := strings.HasPrefix(raw, "(") || wrapOpenRe.MatchString(text[:loc[0]])
		closed := strings.HasSuffix(raw, ")") || wrapCloseRe.MatchString(rest)
		n.negative = opened && closed ||
			strings.HasPrefix(strings.TrimPrefix(raw, "("), "-") ||
			minusBeforeRe.MatchString(text[:loc[0]])
		short := rest
		if len(short) > 40 {
			short = short[:40]
		}
		n.after = strings.ToLower(short)
		n.amount = n.dollar || n.scale != "" || strings.Contains(raw, ".") || thousandsSepRe.MatchString(raw) ||
			centsAfterRe.MatchString(n.after) || strings.HasPrefix(strings.TrimSpace(n.after), "%")
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
	numbers := findNumbers(text)
	var match *textNumber
	for i, n := range numbers {
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
				match = &numbers[i]
			}
		}
		if match != nil {
			break
		}
	}
	if match == nil {
		return 0, "value not found in its quote with an unambiguous scale", false
	}
	v := math.Abs(mill) * 1e6
	switch col {
	case "revenue":
		if mill < 0 || match.negative {
			return 0, "negative revenue", false
		}
	case "net_income":
		loss, ok := figureIsLoss(text, *match, numbers, mill < 0)
		if !ok {
			return 0, reasonSignAmbiguous, false
		}
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

	numbers := findNumbers(text)
	var match *textNumber
	for i, n := range numbers {
		if sameNumber(n.value, math.Abs(v)) && n.scale == "" {
			match = &numbers[i]
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
	loss, signOK := figureIsLoss(text, *match, numbers, v < 0)
	if !signOK {
		return epsReading{}, reasonSignAmbiguous, false
	}
	if loss {
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

// ------------------------------------------------------------------ sign

// signClass is the sign a word gives a figure.
type signClass int

const (
	signNone signClass = iota
	signProfit
	signLoss
	// signAmbiguous: the nearest sign word before the figure belongs to an
	// amount tagged as a comparative ("a loss of $3.1m in the pcp became
	// $45.2m"): it may or may not carry over to the figure, so neither sign
	// is read.
	signAmbiguous
)

var (
	// signWordRe: the words that sign a net income or EPS figure. Group 1 is
	// a loss word (loss, net loss, loss after tax, loss per share, deficit,
	// negative), group 2 a profit word (profit, net profit, profit after tax,
	// NPAT, NPATA, earnings, earnings per share, EPS).
	signWordRe = regexp.MustCompile(`(?i)\b(?:(loss(?:es)?|deficit|negative)|(profit|npata?|earnings|eps))\b`)
	// neutralSignRe: phrases holding a sign word that say nothing about the
	// figure's sign, blanked before the sign words are read: a statement or
	// line naming both ("statement of profit or loss", "profit and loss",
	// "earnings/loss") and a partial item ("impairment losses", "loss on
	// disposal", "retained earnings").
	neutralSignRe = regexp.MustCompile(`(?i)\b(?:profit|earnings|income)\s*(?:or|and|/)\s*loss(?:es)?\b|` +
		`\bloss(?:es)?\s*(?:or|and|/)\s*(?:profit|earnings)\b|` +
		`\b(?:impairment|credit|fair[- ]value|foreign[- ]exchange|fx|currency|exchange|translation|actuarial|hedging|revaluation|derivative)\s+loss(?:es)?\b|` +
		`\bloss(?:es)?\s+on\s+(?:the\s+)?(?:sale|disposal|revaluation|remeasurement|derecognition|extinguishment)\b|` +
		`\bretained\s+earnings\b|\bearnings\s+guidance\b`)
	// signComparisonLeadRe: gate 4's comparison vocabulary
	// (comparisonLeadTerms: compared with, versus, vs, from as in "up from"
	// and "down from", ...) anywhere before a sign word, plus the comparative
	// period tags a sign word can follow ("pcp loss", "prior year loss").
	signComparisonLeadRe = regexp.MustCompile(`(?i)\b(?:` + comparisonLeadTerms + `)\b|` +
		`\bp\.?c\.?p\b|\b(?:prior|previous)\s+corresponding\s+(?:period|half|year)\b|` +
		`\b(?:last|prior|previous)\s+(?:financial\s+)?(?:year|half)\b`)
	// signAfterRe: a sign word IMMEDIATELY after a figure, past its scale and
	// unit ("$12.3 million loss", "12.3m net loss after tax", "3.4 cents loss
	// per share"). Group 1 is a loss word, group 2 a profit word.
	signAfterRe = regexp.MustCompile(`(?i)^(?:\s*(?:billion|bn|b|million|mn|mill|m|thousand|k)\b\.?)?` +
		`(?:\s*(?:(?:us|nz|a)\s?)?(?:(?:cents?|c|cps)\b|¢))?` +
		`\s*(?:(?:net|statutory|reported|after[- ]tax)\s+)*` +
		`(?:(loss(?:es)?|deficit)|(profit|npata?|earnings))\b`)
	// comparativeTagRe: a comparative-period tag right after an amount, past
	// its scale and unit ("$3.1 million in the pcp", "0.8 cents last year").
	comparativeTagRe = regexp.MustCompile(`(?i)^(?:\s*(?:billion|bn|b|million|mn|mill|m|thousand|k)\b\.?)?` +
		`(?:\s*(?:(?:cents?|c|cps)\b|¢))?\s*(?:(?:in|for|during|over)\s+)?(?:the\s+)?` +
		`(?:p\.?c\.?p\b|(?:prior|previous)\s+corresponding\s+(?:period|half|year)\b|(?:last|prior|previous)\s+(?:financial\s+)?(?:year|half|period)\b)`)
	// sentenceAbbrevRe: a word whose full stop does not end a sentence.
	sentenceAbbrevRe = regexp.MustCompile(`(?i)\b(?:vs|no|approx|incl|excl|cf|ltd|inc|co|corp|pty)$`)
)

// figureIsLoss decides whether the figure n of a net income or EPS quote is a
// loss (review findings C3 and C6; gate 5's sign reading):
//
//  1. the figure's own sign decides: a minus or parentheses
//     (textNumber.negative);
//  2. otherwise the NEAREST sign word before the figure in its clause
//     (signBefore), a sign word immediately after it (signAfter) and the
//     value attribute's own sign (attrNegative) each speak, and every one
//     that speaks must agree. A profit word governing a negative attribute,
//     or a loss word before the figure and a profit word right after it, is
//     ambiguous: ok=false, the value is withheld.
//
// Nothing speaking is a profit, as the statements print one.
func figureIsLoss(text string, n textNumber, numbers []textNumber, attrNegative bool) (loss, ok bool) {
	if n.negative {
		return true, true
	}
	t := neutralSignRe.ReplaceAllStringFunc(text, func(s string) string { return strings.Repeat(" ", len(s)) })
	before := signBefore(t, n.pos, numbers)
	if before == signAmbiguous {
		return false, false
	}
	votes := []signClass{before, signAfter(t[n.end:])}
	if attrNegative {
		votes = append(votes, signLoss)
	}
	got := signNone
	for _, v := range votes {
		if v == signNone {
			continue
		}
		if got != signNone && v != got {
			return false, false
		}
		got = v
	}
	return got == signLoss, true
}

// signAfter is the class of a sign word right after a figure (rest is the
// text past it).
func signAfter(rest string) signClass {
	m := signAfterRe.FindStringSubmatchIndex(rest)
	switch {
	case m == nil:
		return signNone
	case m[2] >= 0:
		return signLoss
	default:
		return signProfit
	}
}

// signBefore is the class of the nearest sign word before the figure at pos
// that governs it:
//
//   - in the figure's clause, back to a ';' or a sentence end;
//   - at the figure's own parenthesis level or an enclosing one, so a closed
//     parenthetical before it ("(pcp: loss of $3.1m)") is skipped, the
//     parenthesis-depth rule of quoteNamesOnlyOtherPeriods;
//   - outside a comparison that ends before the figure ("up from a loss of
//     $3.1m to $45.2m": the loss is the comparative's).
//
// When that nearest word sits with an amount tagged as a comparative ("a loss
// of $3.1m in the pcp became $45.2m") the answer is signAmbiguous: whether
// the loss carries over to the figure is not in the words. t is the quote
// with the neutral phrases blanked.
func signBefore(t string, pos int, numbers []textNumber) signClass {
	start, d := 0, 0
	level := make([]bool, pos) // at the figure's level or an enclosing one
	for i := pos - 1; i >= 0; i-- {
		c := t[i]
		level[i] = d == 0
		if d == 0 && (c == ';' || sentenceEnd(t, i)) {
			start = i + 1
			break
		}
		switch c {
		case ')':
			d++
		case '(':
			if d > 0 {
				d--
			}
		}
	}
	starts := make(map[int]textNumber, len(numbers))
	for _, n := range numbers {
		starts[n.pos] = n
	}
	type span struct{ lo, hi int }
	var comparisons []span
	for _, m := range signComparisonLeadRe.FindAllStringIndex(t[start:pos], -1) {
		lo, hi := start+m[0], start+m[1]
		if !level[lo] {
			continue
		}
		if end, ok := comparisonScopeEnd(t, hi, pos, starts); ok {
			comparisons = append(comparisons, span{lo, end})
		}
	}
	// Tagged comparatives: an amount followed by "in the pcp" / "last year",
	// with the words before it back to a ',' or ';', a comparison lead or the
	// previous amount.
	var tagged []span
	prevEnd := start
	for _, n := range numbers {
		if n.pos < start || n.pos >= pos || !level[n.pos] || !n.amount {
			continue
		}
		if m := comparativeTagRe.FindStringIndex(t[n.end:pos]); m != nil {
			lo := prevEnd
			for i := n.pos - 1; i >= prevEnd; i-- {
				if level[i] && (t[i] == ',' || t[i] == ';') {
					lo = i + 1
					break
				}
			}
			for _, c := range comparisons {
				if c.lo >= lo && c.lo < n.pos {
					lo = c.lo
				}
			}
			tagged = append(tagged, span{lo, n.end + m[1]})
		}
		prevEnd = n.end
	}
	within := func(p int, spans []span) bool {
		for _, s := range spans {
			if p >= s.lo && p < s.hi {
				return true
			}
		}
		return false
	}
	best := signNone
	for _, m := range signWordRe.FindAllStringSubmatchIndex(t[start:pos], -1) {
		p := start + m[0]
		if !level[p] || within(p, comparisons) {
			continue
		}
		switch {
		case within(p, tagged):
			best = signAmbiguous
		case m[2] >= 0:
			best = signLoss
		default:
			best = signProfit
		}
	}
	return best
}

// comparisonScopeEnd is where a comparison whose lead ends at from stops: at
// the end of its first amount ("compared with a loss of $3.1m"), or at a ',',
// a ';', a sentence end or the ')' closing its parenthetical, whichever comes
// first. ok is false when it runs on to the figure at pos: the figure is then
// the comparison's own amount, and a sign word inside it is the figure's.
func comparisonScopeEnd(t string, from, pos int, starts map[int]textNumber) (int, bool) {
	d := 0
	for i := from; i < pos; i++ {
		if n, ok := starts[i]; ok && d == 0 && n.amount {
			return n.end, true
		}
		switch c := t[i]; {
		case c == '(':
			d++
		case c == ')':
			if d == 0 {
				return i, true
			}
			d--
		case d == 0 && (c == ',' || c == ';' || sentenceEnd(t, i)):
			return i, true
		}
	}
	return 0, false
}

// sentenceEnd reports whether t[i] is a full stop ending a sentence: followed
// by white space and a capital, and not an abbreviation's ("vs.", "Ltd.").
// A decimal point is never one.
func sentenceEnd(t string, i int) bool {
	if t[i] != '.' {
		return false
	}
	j := i + 1
	if j >= len(t) || (t[j] != ' ' && t[j] != '\n' && t[j] != '\t') {
		return false
	}
	for j < len(t) && (t[j] == ' ' || t[j] == '\n' || t[j] == '\t') {
		j++
	}
	if j >= len(t) || t[j] < 'A' || t[j] > 'Z' {
		return false
	}
	return !sentenceAbbrevRe.MatchString(t[:i])
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
