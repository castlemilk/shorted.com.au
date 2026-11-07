package backtest

import (
	"errors"
	"math"
	"sort"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/instrument"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/pipeline"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// LiquidDV20AUD is the liquidity floor of the same-data reference: a 20-session
// dollar volume of at least A$250,000.
const LiquidDV20AUD = 250000

// Basis is a return basis. A total-return curve is never chained onto a
// price-return one.
type Basis string

// The two bases. Every canonical run, its variants and the paper track are total.
const (
	BasisTotal Basis = "total"
	BasisPrice Basis = "price"
)

// Series is a daily curve with the basis it was measured on.
type Series struct {
	Basis Basis
	Curve Curve
}

var errNoSessions = errors.New("backtest: no sessions to measure")

// refPosition is one equal-weight holding of the reference on the P&L basis.
type refPosition struct {
	units   float64 // notional / entry P&L price, as the simulator counts units
	lastPL  float64 // last P&L-basis price
	missing int     // consecutive sessions without a priced bar
}

// refTrack is one code's P&L-basis path over the recorded sessions: the price
// (zero where the code has no priced bar), the multiplier it was priced on, and
// the cash dividend per share credited on the session.
type refTrack struct {
	pl   []float64
	mult []float64
	div  []float64
}

// trackOf walks a code's bars over sessions with the simulator's per-bar rule
// (ClassifyBar): the multiplier steps on a total-return bar, except the bar a cash
// dividend is credited on. The reference therefore reads the same returns the
// strategy does, from the same rows.
func trackOf(bars []features.Bar, sessions []civil.Date, divAt []float64, price4dp civil.Date) refTrack {
	n := len(sessions)
	tr := refTrack{pl: make([]float64, n), mult: make([]float64, n), div: make([]float64, n)}
	mult := 1.0
	var prev features.Bar
	hasPrev := false
	for k, t := range sessions {
		b := barOn(bars, t)
		if b == nil {
			continue
		}
		cur := *b
		cur.Date = t
		basis := ClassifyBar(prev, cur, hasPrev, t, price4dp)
		credited := divAt[k] > 0 && basis.Unadjusted
		if basis.TotalReturn && !credited {
			mult *= math.Exp(basis.RK)
		}
		if credited {
			tr.div[k] = divAt[k]
		}
		tr.pl[k] = cur.Close * mult
		tr.mult[k] = mult
		prev, hasPrev = cur, true
	}
	return tr
}

// Reference is the same-data reference of recipe r: equal weight across the
// recipe's reference universe on the first recorded session of each month, held
// until the next month's first session, priced on the P&L basis from the same
// rows, with no costs. A held code with no bar for the stale-exit run exits at its
// last mark and its share stays in cash until the next rebalance, as a delisting
// does for the strategy. The reference does not remove survivorship bias: its
// universe is the codes with rows in the window.
//
// The curve starts on the window's first session with the recipe's capital.
func Reference(in Inputs, s spec.Spec, r spec.Recipe, sessions []civil.Date) (Series, error) {
	if len(sessions) == 0 {
		return Series{}, errNoSessions
	}
	pin, mkt, err := pipelineInputs(in)
	if err != nil {
		return Series{}, err
	}
	rs, err := newReportSet(in, s)
	if err != nil {
		return Series{}, err
	}
	price4dp, err := civil.ParseDate(s.Data.Price4dpFrom)
	if err != nil || price4dp.IsZero() {
		return Series{}, errors.New("backtest: the version has no price_4dp_from")
	}
	asic := map[string][]features.ASICRow{}
	for _, row := range pin.ASIC {
		asic[row.Code] = append(asic[row.Code], row)
	}
	for code := range asic {
		rows := asic[code]
		sort.SliceStable(rows, func(i, j int) bool { return rows[i].ReportDate.Before(rows[j].ReportDate) })
	}
	tracks := make(map[string]refTrack, len(pin.Codes))
	for _, code := range pin.Codes {
		tracks[code] = trackOf(pin.Bars[code], sessions, dividendsBySession(pin.Dividends[code], sessions), price4dp)
	}

	members := func(k int, t civil.Date) []string {
		return referenceMembers(in, mkt, pin, rs, asic, s, r, t, k, tracks)
	}
	return Series{Basis: BasisTotal, Curve: referenceCurve(r.Capital, sessions, tracks, members)}, nil
}

// referenceCurve is the equal-weight holding of the reference over the recorded
// sessions. members returns the codes held from a rebalance session, which is the
// first session and each first session of a later month. The holdings are marked
// at each close, their dividends are credited to cash, and a holding with no bar
// for the stale-exit run is sold at its last mark into cash, which stays there
// until the next rebalance. A rebalance sells everything at the close and buys the
// members in equal weight at it, so the equity is unchanged by the trade.
func referenceCurve(capital float64, sessions []civil.Date, tracks map[string]refTrack,
	members func(k int, t civil.Date) []string) Curve {
	cash := capital
	holdings := map[string]*refPosition{}
	out := Curve{Dates: make([]civil.Date, 0, len(sessions)), Values: make([]float64, 0, len(sessions))}
	for k, t := range sessions {
		for _, code := range sortedKeys(holdings) {
			pos := holdings[code]
			tr := tracks[code]
			if tr.pl[k] > 0 {
				pos.lastPL = tr.pl[k]
				pos.missing = 0
				if tr.div[k] > 0 {
					cash += tr.div[k] * pos.units * tr.mult[k]
				}
				continue
			}
			pos.missing++
			if pos.missing >= defaultStaleSessions {
				cash += pos.units * pos.lastPL
				delete(holdings, code)
			}
		}
		if k == 0 || t.Month != sessions[k-1].Month || t.Year != sessions[k-1].Year {
			equity := cash
			for _, code := range sortedKeys(holdings) {
				equity += holdings[code].units * holdings[code].lastPL
			}
			holdings = map[string]*refPosition{}
			cash = equity
			if codes := members(k, t); len(codes) > 0 {
				per := equity / float64(len(codes))
				for _, code := range codes {
					pl := tracks[code].pl[k]
					holdings[code] = &refPosition{units: per / pl, lastPL: pl}
				}
				cash = equity - per*float64(len(codes))
			}
		}
		equity := cash
		for _, code := range sortedKeys(holdings) {
			equity += holdings[code].units * holdings[code].lastPL
		}
		out.Dates = append(out.Dates, t)
		out.Values = append(out.Values, equity)
	}
	return out
}

// referenceMembers are the codes the reference holds from a rebalance: priced on
// the session, ordinary on the universe's rule, at or above the liquidity floor on
// the session's 20-session dollar volume, and, for the Crowded-Short reference,
// reporting at least the qualifying short position in R*(t). The result is sorted,
// so equal weight never depends on map order.
func referenceMembers(in Inputs, mkt Market, pin *pipeline.Inputs, rs *reportSet, asic map[string][]features.ASICRow,
	s spec.Spec, r spec.Recipe, t civil.Date, k int, tracks map[string]refTrack) []string {
	var qual map[string]bool
	if r.Reference == spec.ReferenceCrowdedShorts {
		qual = map[string]bool{}
		for _, code := range qualifying(rs.ordinaryRows(in, t), CoverageMinPct) {
			qual[code] = true
		}
	}
	var out []string
	for _, code := range pin.Codes {
		if tracks[code].pl[k] <= 0 {
			continue
		}
		if qual != nil && !qual[code] {
			continue
		}
		row, _ := newestRow(asic, code, t)
		if instrument.IneligibleReason(code, row.Product, mkt.Names[code], row.Issued, mkt.ETPs, true) != "" {
			continue
		}
		pf, ok := features.AsOf(pin.Bars[code], pin.XJO, t, s.Features)
		if !ok || pf.DollarVolume20d == nil || *pf.DollarVolume20d < LiquidDV20AUD {
			continue
		}
		out = append(out, code)
	}
	return out
}

// newestRow is the code's newest ASIC row dated on or before t, the row the
// universe reads for its product and shares. ok is false when there is none.
func newestRow(rows map[string][]features.ASICRow, code string, t civil.Date) (features.ASICRow, bool) {
	rs := rows[code]
	i := sort.Search(len(rs), func(i int) bool { return rs[i].ReportDate.After(t) })
	if i == 0 {
		return features.ASICRow{}, false
	}
	return rs[i-1], true
}
