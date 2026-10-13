package extractiontrust

import (
	"encoding/json"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
)

// Keys the extractor writes into a dividend entry (direct_extract.py): unit
// says which value key holds the figure.
const (
	KeyUnit         = "unit"
	KeyValueCents   = "value_cents"
	KeyValueDollars = "value_dollars"
)

// perSecurityRE is a quote that states its figure per share, security, unit or
// CDI, with up to three words between ("per stapled security", "per fully paid
// ordinary share", "Amount per Quoted Equity Security"), or after a slash
// ("$0.1432/unit"). Matched against Normalise(quote).
var perSecurityRE = regexp.MustCompile(`\bper\s+(?:[a-z0-9&'.-]+\s+){0,3}(?:shares?|securit(?:y|ies)|units?|cdis?|depositary\s+interests?)\b|/\s*(?:shares?|securit(?:y|ies)|units?|cdis?)\b`)

// plainDecimalRE is the only spelling an amount is read from: digits, at most
// one decimal point. No sign, exponent, thousands separator or currency.
var plainDecimalRE = regexp.MustCompile(`^\d+(?:\.\d+)?$`)

// PerSecurityAmount is a dividend entry's amount per security, in the major
// unit of the document's currency (dollars), as an exact decimal. It reads
// value_cents / 100 when unit is "cents", and value_dollars when unit is
// "dollars" only if the quote says the figure is per share, security, unit or
// CDI. Anything else is unread (false): no unit, a value that is not a plain
// decimal (two prod entries hold the string "null"), or a dollar figure the
// quote does not put per security.
//
// Dollar entries are read, with that condition. 45 of 1,409 prod dividend
// entries are in dollars (2026-10-12); some are per-share amounts ("A fully
// franked dividend of $0.04 per share", BCN), and some are aggregates the
// condition keeps out ("Dividends paid, recommended or declared during the
// financial year are $264,167", N1H; "Dividends declared for the half year
// amounted to PGK 41,812,470", KSL). LRT's only entry ("A $0.1432/unit
// distribution to unitholders was announced") is read here; what keeps LRT's
// estimate unstored is that entry's consensus (one model) and its label, not
// its unit.
//
// Compare amounts with (*big.Rat).Cmp, never as float64: value_cents / 100 ==
// amount is false in float64 for about a quarter of one- and two-decimal cent
// values (1.3 / 100 is not 0.013, MXT's September 2026 distribution).
func PerSecurityAmount(entry map[string]any) (*big.Rat, bool) {
	unit, _ := entry[KeyUnit].(string)
	switch strings.TrimSpace(unit) {
	case "cents":
		cents, ok := amountValue(entry[KeyValueCents])
		if !ok {
			return nil, false
		}
		return cents.Quo(cents, big.NewRat(100, 1)), true
	case "dollars":
		quote, _ := entry[KeySourceText].(string)
		if !perSecurityRE.MatchString(Normalise(quote)) {
			return nil, false
		}
		return amountValue(entry[KeyValueDollars])
	}
	return nil, false
}

// ParseAmount reads a plain decimal ("0.15", "4.150", "15") as an exact
// decimal; false for anything else. A notice's float amount compares exactly
// once spelled with strconv.FormatFloat(f, 'f', -1, 64): the shortest
// spelling of a float parsed from at most 15 significant digits is the
// decimal it was parsed from.
func ParseAmount(s string) (*big.Rat, bool) {
	s = strings.TrimSpace(s)
	if !plainDecimalRE.MatchString(s) {
		return nil, false
	}
	return new(big.Rat).SetString(s)
}

// amountValue is a stored value as an exact decimal: the extractor writes
// strings; a number decoded by encoding/json is read by its shortest spelling.
func amountValue(v any) (*big.Rat, bool) {
	switch x := v.(type) {
	case string:
		return ParseAmount(x)
	case json.Number:
		return ParseAmount(x.String())
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) || x < 0 {
			return nil, false
		}
		return ParseAmount(strconv.FormatFloat(x, 'f', -1, 64))
	}
	return nil, false
}
