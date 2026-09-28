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
	// ValuationNoteNonAUD: the statements are not in AUD (or the vendor's are
	// FX-converted from another currency), so a price-based ratio would
	// divide an AUD price by a foreign-currency figure.
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
	// allowed it, and for every code the job has not fetched since 000132.
	MedianK *float64
	// KPeriods / KConsistent / KFarFromOne stand in when MedianK is nil: how
	// many vendor annual / TTM periods allow k, whether every one is within
	// [0.8, 1.25], and whether any positive k is outside [1/3, 3] (a k <= 0,
	// net income and EPS of opposite signs, is no evidence about the unit).
	KPeriods    int32
	KConsistent bool
	KFarFromOne bool

	// FXConverted is stock_fundamentals_sync.fx_converted: the vendor's
	// statements for this code are converted from another currency (plan
	// §3.4). Yahoo converts EVERY monetary and per-share value of such a
	// code, EPS included, whatever currency label it puts on a point (XRO's
	// FY25 EPS 1.3541 is Yahoo's AUD net income over the share count, not
	// Xero's NZD EPS), so no price-based ratio is computed from them. Before
	// the job has measured the code (fx_converted NULL), the store reads a
	// fractional vendor revenue or net income as the same verdict.
	FXConverted bool

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
//     valued. The note is "listed-unit" only on positive evidence: a median
//     outside [0.8, 1.25], or, without a median, a period whose k is outside
//     [1/3, 3]. Anything else (no k at all, or a k between the bands, as a
//     recent IPO or placement shows) is "no-shares", which lets the picker
//     fall back to the screener's market cap. Price-based ratios need a
//     one-ordinary-share listing (plan §1); an FX-converted code measured
//     since 000132 has no k (its monetary and per-share fields are rejected),
//     so it is not valued here either.
//   - Market cap = close x shares, the newest vendor share count dated no
//     more than 12 months before the close. AUD whatever the reporting
//     currency, because it is price times a count.
//   - P/E = close / E, E the newest 12-month EPS across annual and TTM rows
//     (diluted when present, else basic) dated no more than 12 months before
//     the close; nil when E <= 0 or the statements are not AUD.
//   - P/B = market cap / the aligned total equity of q; AUD statements and
//     equity > 0 only.
//   - An FX-converted code (in.FXConverted) gets no P/E or P/B whatever its
//     rows' currency label says; market cap, a price times a count, is
//     still governed by the listing evidence alone.
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
		case in.FXConverted || in.EPSCurrency != audCurrency:
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
		case in.FXConverted || currency != audCurrency:
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
// no evidence either way).
//
//   - With median_k: ok within [0.8, 1.25], contradicted otherwise.
//   - Without it (fewer than 3 periods, or not fetched since 000132): ok when
//     at least one period allows k and every k is within [0.8, 1.25];
//     contradicted when any k is outside [1/3, 3], the identity gate's own
//     3x (a CDI's k sits near 10 or 0.1: RMD carries ten CDIs per share);
//     otherwise (no k, or a k between the bands) no evidence. A k between
//     the bands is what an ordinary recent issuer shows: EPS on the
//     weighted-average share count against the period-end count, so an IPO
//     or a late placement gives 0.7 to 0.8. The store computes both flags
//     (the kk lateral of fundamentalsExtras).
func oneShareListing(in *ValuationInputs) (ok, contradicted bool) {
	if in.MedianK != nil {
		k := *in.MedianK
		ok = isFinite(k) && k >= listedUnitMinK && k <= listedUnitMaxK
		return ok, !ok
	}
	switch {
	case in.KPeriods >= 1 && in.KConsistent:
		return true, false
	case in.KPeriods >= 1 && in.KFarFromOne:
		return false, true
	}
	return false, false
}
