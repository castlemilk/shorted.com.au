package main

import (
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/castlemilk/shorted.com.au/services/pkg/housingcrawl"
)

// Australian listing price strings are wildly inconsistent: "$1,250,000",
// "$1.2m", "Offers over $985k", "$1.2m - $1.4m", "Auction", "Contact Agent",
// "Guide $2.3m", "POA". parseAUPrice classifies the string into a price_kind and
// returns the canonical numeric(s). Only rows with a non-nil canonical price feed
// drop detection — auction/POA/unknown carry NULL numerics on purpose, so a guide
// appearing or an auction resolving never reads as a phantom price move.

// dollarAmtRe matches a $-prefixed amount with an optional m/k (or word) suffix.
// Requiring the leading $ avoids harvesting bed/bath counts out of a display
// string like "4 bed 2 bath $1.2m".
var dollarAmtRe = regexp.MustCompile(`\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(m|million|k|thousand)?`)

// price-string keyword markers (matched on the lowercased string).
var (
	poaMarkers = []string{
		"contact agent", "poa", "price on application", "by negotiation",
		"expressions of interest", "eoi", "under offer", "on request",
		"just listed", "new listing", "price guide available", "forthcoming",
	}
	offersOverMarkers = []string{"offers over", "offers above", "offers from", "starting", "from $", "guide over"}
	upToMarkers       = []string{"under $", "below $", "up to $"}
	rangeSeparators   = []string{" - ", "-", "–", "—", " to "}
)

// parseAllDollarAmounts returns every plausible $-amount in a lowercased string.
func parseAllDollarAmounts(lower string) []float64 {
	var out []float64
	for _, m := range dollarAmtRe.FindAllStringSubmatch(lower, -1) {
		num, err := strconv.ParseFloat(strings.ReplaceAll(m[1], ",", ""), 64)
		if err != nil {
			continue
		}
		switch m[2] {
		case "m", "million":
			num *= 1_000_000
		case "k", "thousand":
			num *= 1_000
		}
		// Round to whole dollars: "$4.1m" is 4099999.9999999995 in float64.
		num = math.Round(num)
		if num > 0 {
			out = append(out, num)
		}
	}
	return out
}

// Price kinds, aliased from the store (housingcrawl), which owns them.
const (
	priceFixed      = housingcrawl.PriceFixed
	priceRangeLow   = housingcrawl.PriceRangeLow
	priceRangeHigh  = housingcrawl.PriceRangeHigh
	priceOffersOver = housingcrawl.PriceOffersOver
	priceAuction    = housingcrawl.PriceAuction
	pricePOA        = housingcrawl.PricePOA
	priceUnknown    = housingcrawl.PriceUnknown
)

// parseAUPrice classifies a listing price string. `low`/`high` are the parsed
// bound(s) (nil when absent); `kind` is one of the price* constants.
func parseAUPrice(display string) (low, high *float64, kind string) {
	s := strings.ToLower(strings.TrimSpace(display))
	if s == "" {
		return nil, nil, priceUnknown
	}
	nums := parseAllDollarAmounts(s)

	// No dollar figure: an auction/POA keyword sets the kind, else unknown.
	if len(nums) == 0 {
		switch {
		case strings.Contains(s, "auction"):
			return nil, nil, priceAuction
		case containsAny(s, poaMarkers):
			return nil, nil, pricePOA
		default:
			return nil, nil, priceUnknown
		}
	}

	// A genuine numeric range: two+ figures AND a range separator.
	if len(nums) >= 2 && containsAny(s, rangeSeparators) {
		lo, hi := minMaxFloat(nums)
		return new(lo), new(hi), priceRangeLow
	}

	n := nums[0]
	switch {
	case containsAny(s, offersOverMarkers):
		return new(n), nil, priceOffersOver
	case containsAny(s, upToMarkers):
		return nil, new(n), priceRangeHigh
	default:
		return new(n), nil, priceFixed
	}
}

func containsAny(s string, subs []string) bool {
	for _, sub := range subs {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

func minMaxFloat(vs []float64) (min, max float64) {
	min, max = vs[0], vs[0]
	for _, v := range vs[1:] {
		if v < min {
			min = v
		}
		if v > max {
			max = v
		}
	}
	return min, max
}

// canonicalPrice is the single numeric used for drop detection. See
// housingcrawl.CanonicalPrice.
func canonicalPrice(low, high *float64, kind string) *float64 {
	return housingcrawl.CanonicalPrice(low, high, kind)
}
