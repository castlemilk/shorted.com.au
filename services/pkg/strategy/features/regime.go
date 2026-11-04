package features

import (
	"time"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
)

// The regime's fixed windows, which match the v0 spec's regime and fs1
// parameters (TestRegimeWindowsMatchSpec pins them).
const (
	regimeHistoryDays = 400 // the window is [D - 400 days, D]
	regimeSMAFast     = 50
	regimeSMASlow     = 200
	regimeHigh52Ranks = 252
	regimeTolerance   = 10 // days a 1- or 3-month anchor may lag its target
)

// Regime is the exact port of mv_market_regime evaluated at session D: the XJO
// close, its 50- and 200-session averages (full windows only), the distance
// from its 52-week high, the 1- and 3-month returns, and the label. The label
// is empty when the close or an average is unknown, which every regime rule
// reads as unknown. The result names the index DefaultIndexCode.
//
// The stored regime is the newest index bar on or before D; when the index did
// not trade on D, AsOf is that earlier date.
func Regime(xjo []IndexBar, D civil.Date) engine.Regime {
	from := windowStart(D, regimeHistoryDays)
	w := make([]pt, 0, len(xjo))
	for i := range xjo {
		b := &xjo[i]
		if b.Date.Before(from) || b.Date.After(D) || !indexUsable(b.Close) {
			continue
		}
		w = append(w, indexPoint(*b))
	}
	out := engine.Regime{IndexCode: engine.DefaultIndexCode}
	n := len(w)
	if n == 0 {
		return out
	}

	at := func(rank int) *pt { return &w[n-rank] }
	asOf := at(1).date
	last := at(1).close
	t := asOf.In(time.UTC)
	out.AsOf = &t
	out.Close = &last

	if n >= regimeSMAFast {
		v := regimeMean(w, n, regimeSMAFast)
		out.SMA50 = &v
	}
	if n >= regimeSMASlow {
		v := regimeMean(w, n, regimeSMASlow)
		out.SMA200 = &v
	}

	high52 := 0.0
	for rank := 1; rank <= min(n, regimeHigh52Ranks); rank++ {
		if rank == 1 || at(rank).high > high52 {
			high52 = at(rank).high
		}
	}
	if high52 > 0 {
		v := min(0, (last-high52)/high52*100)
		out.PctOff52wHigh = &v
	}

	ret1, _, _, _ := calendarReturn(w, asOf, 1, regimeTolerance, last)
	ret3, _, _, _ := calendarReturn(w, asOf, 3, regimeTolerance, last)
	out.Ret1mPct = ret1
	out.Ret3mPct = ret3

	switch {
	case out.SMA50 == nil || out.SMA200 == nil:
		out.Label = ""
	case last > *out.SMA50 && *out.SMA50 > *out.SMA200:
		out.Label = engine.RegimeUptrend
	case last > *out.SMA200:
		out.Label = engine.RegimeNeutral
	default:
		out.Label = engine.RegimeDowntrend
	}
	return out
}

// regimeMean is the mean close over the newest size ranks of a window of n.
func regimeMean(w []pt, n, size int) float64 {
	sum := 0.0
	for rank := 1; rank <= size; rank++ {
		sum += w[n-rank].close
	}
	return sum / float64(size)
}
