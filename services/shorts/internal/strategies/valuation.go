package strategies

import "time"

// Valuation notes (FundamentalsQuality.valuation_note): why market cap, P/E or
// P/B are absent. Empty when nothing needs explaining.
const (
	// ValuationNoteNoPrice: no usable latest close.
	ValuationNoteNoPrice = "no-price"
	// ValuationNoteListedUnit: the listed unit is not one ordinary share
	// (a CDI such as RMD carries ~10 per share), so neither close x shares nor
	// close / EPS is a valuation.
	ValuationNoteListedUnit = "listed-unit"
	// ValuationNoteNonAUD: the statements are not in AUD, so a price-based
	// ratio would divide an AUD price by a foreign-currency figure.
	ValuationNoteNonAUD = "non-aud"
	// ValuationNoteNoShares: no share count we can vouch for (none within 12
	// months, or no evidence that the listed unit is one share).
	ValuationNoteNoShares = "no-shares"
)

// P/E EPS bases (FundamentalsQuality.pe_eps_basis).
const (
	PEBasisDiluted = "diluted"
	PEBasisBasic   = "basic"
)

const (
	// listedUnitMinK / listedUnitMaxK bound k = net income / (EPS x shares)
	// for a listing whose unit is one ordinary share (plan §5.3).
	listedUnitMinK = 0.8
	listedUnitMaxK = 1.25
	// valuationMaxAgeMonths: a share count or an EPS older than this, measured
	// back from the close, is not used.
	valuationMaxAgeMonths = 12
	audCurrency           = "AUD"
)

// ValuationInputs are the stock_fundamentals facts valuation needs, read
// beside the quality row by the store (fundamentalsExtras). nil fields are
// unknown.
type ValuationInputs struct {
	// Shares is shares_outstanding from the newest VENDOR row (annual, ttm or
	// quarter) that carries one; SharesPeriodEnd is that row's end.
	Shares          *float64
	SharesPeriodEnd *time.Time

	// MedianK is stock_fundamentals_sync.median_k: the code's median of
	// net income / (basic EPS x shares) across its vendor periods, the
	// identity-gate reference (plan §3.5). nil when fewer than 3 periods
	// allowed it.
	MedianK *float64
	// KPeriods / KConsistent stand in when MedianK is nil: how many vendor
	// annual / TTM periods allow k, and whether every one is within
	// [0.8, 1.25].
	KPeriods    int32
	KConsistent bool

	// The newest 12-month EPS across annual and TTM rows (diluted and basic
	// from the same row), its period end and the row's currency.
	EPSDiluted   *float64
	EPSBasic     *float64
	EPSPeriodEnd *time.Time
	EPSCurrency  string
}

// Valuation is market cap, P/E and P/B from our own latest close (plan
// §5.3). nil values are unknown; Note says why the headline values are
// absent.
type Valuation struct {
	MarketCap      *float64 // AUD: latest close x shares on issue
	PERatio        *float64
	PriceToBook    *float64
	PriceAsOf      *time.Time
	SharesAsOf     *time.Time
	PEEPSPeriodEnd *time.Time
	PEEPSBasis     string // PEBasisDiluted | PEBasisBasic
	Note           string // ValuationNote*; "" when nothing needs explaining
}

// HasAny reports whether any valuation figure is known.
func (v Valuation) HasAny() bool {
	return v.MarketCap != nil || v.PERatio != nil || v.PriceToBook != nil
}

// Valuate is THE valuation function (plan §5.3), used by the stock page, the
// picks and sorting:
//
//   - The listed unit must be one ordinary share: median_k within
//     [0.8, 1.25], or, without a median, at least one vendor period whose k is
//     computable and every such k within that range. Otherwise nothing is
//     valued ("listed-unit" when the evidence contradicts it, "no-shares"
//     when there is none). Price-based ratios need a one-ordinary-share
//     listing (plan §1), and this is also what withholds valuation from
//     FX-converted codes, whose monetary fields are rejected so no k exists.
//   - Market cap = close x shares, the newest vendor share count dated no
//     more than 12 months before the close. AUD whatever the reporting
//     currency, because it is price times a count.
//   - P/E = close / E, E the newest 12-month EPS across annual and TTM rows
//     (diluted when present, else basic) dated no more than 12 months before
//     the close; nil when E <= 0 or the statements are not AUD.
//   - P/B = market cap / the aligned total equity of q; AUD statements and
//     equity > 0 only.
//
// in == nil (nothing read, a database before 000132) values nothing and
// explains nothing.
func Valuate(close float64, priceAsOf time.Time, in *ValuationInputs, q *Quality) Valuation {
	var v Valuation
	if in == nil {
		return v
	}
	if !(close > 0) || !isFinite(close) || priceAsOf.IsZero() {
		v.Note = ValuationNoteNoPrice
		return v
	}
	asOf := priceAsOf
	v.PriceAsOf = &asOf
	oldest := priceAsOf.AddDate(0, -valuationMaxAgeMonths, 0)

	if ok, contradicted := oneShareListing(in); !ok {
		v.Note = ValuationNoteNoShares
		if contradicted {
			v.Note = ValuationNoteListedUnit
		}
		return v
	}

	nonAUD, noShares := false, false

	if in.Shares != nil && *in.Shares > 0 && in.SharesPeriodEnd != nil && !in.SharesPeriodEnd.Before(oldest) {
		if mc := close * *in.Shares; isFinite(mc) {
			sharesAsOf := *in.SharesPeriodEnd
			v.MarketCap, v.SharesAsOf = &mc, &sharesAsOf
		}
	} else {
		noShares = true
	}

	eps, basis := in.EPSDiluted, PEBasisDiluted
	if eps == nil {
		eps, basis = in.EPSBasic, PEBasisBasic
	}
	if eps != nil && in.EPSPeriodEnd != nil && !in.EPSPeriodEnd.Before(oldest) {
		switch {
		case in.EPSCurrency != audCurrency:
			nonAUD = true
		case *eps > 0:
			if pe := close / *eps; isFinite(pe) {
				epsEnd := *in.EPSPeriodEnd
				v.PERatio, v.PEEPSPeriodEnd, v.PEEPSBasis = &pe, &epsEnd, basis
			}
		}
	}

	if v.MarketCap != nil && q != nil && q.TotalEquity != nil {
		currency := q.BalanceCurrency
		if currency == "" {
			currency = q.Currency
		}
		switch {
		case currency != audCurrency:
			nonAUD = true
		case *q.TotalEquity > 0:
			if pb := *v.MarketCap / *q.TotalEquity; isFinite(pb) {
				v.PriceToBook = &pb
			}
		}
	}

	switch {
	case nonAUD:
		v.Note = ValuationNoteNonAUD
	case noShares:
		v.Note = ValuationNoteNoShares
	}
	return v
}

// oneShareListing reports whether the listed unit is one ordinary share, and
// whether the evidence positively contradicts it (as opposed to there being
// no evidence at all).
func oneShareListing(in *ValuationInputs) (ok, contradicted bool) {
	if in.MedianK != nil {
		k := *in.MedianK
		ok = isFinite(k) && k >= listedUnitMinK && k <= listedUnitMaxK
		return ok, !ok
	}
	if in.KPeriods >= 1 {
		return in.KConsistent, !in.KConsistent
	}
	return false, false
}
