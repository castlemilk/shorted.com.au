package features

import (
	"math"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// PriceFeatures is one row of mv_price_features. The JSON keys are the view's
// column names, because the snapshot stores this struct as its fs1 object.
// A nil pointer is SQL NULL: unknown, never zero.
type PriceFeatures struct {
	AsOf              civil.Date  `json:"as_of"`
	Close             float64     `json:"close"`
	PrevClose         *float64    `json:"prev_close"`
	SMA10             *float64    `json:"sma10"`
	SMA20             *float64    `json:"sma20"`
	SMA50             *float64    `json:"sma50"`
	SMA150            *float64    `json:"sma150"`
	SMA200            *float64    `json:"sma200"`
	SMA200OneMonthAgo *float64    `json:"sma200_1m_ago"`
	High52w           *float64    `json:"high_52w"`
	Low52w            *float64    `json:"low_52w"`
	PctOff52wHigh     *float64    `json:"pct_off_52w_high"`
	PctAbove52wLow    *float64    `json:"pct_above_52w_low"`
	Volume            float64     `json:"volume"`
	AvgVolume50d      *float64    `json:"avg_volume_50d"`
	VolumeRatio50d    *float64    `json:"volume_ratio_50d"`
	DollarVolume20d   *float64    `json:"dollar_volume_20d"`
	BaseHigh          *float64    `json:"base_high"`
	BaseLow           *float64    `json:"base_low"`
	BaseDepthPct      *float64    `json:"base_depth_pct"`
	BaseLengthDays    *int        `json:"base_length_days"`
	BreakoutRecent    bool        `json:"breakout_recent"`
	BreakoutDate      *civil.Date `json:"breakout_date"`
	Ret1mPct          *float64    `json:"ret_1m_pct"`
	Ret3mPct          *float64    `json:"ret_3m_pct"`
	Ret6mPct          *float64    `json:"ret_6m_pct"`
	Ret12mPct         *float64    `json:"ret_12m_pct"`
	RS3mPct           *float64    `json:"rs_3m_pct"`
	RS6mPct           *float64    `json:"rs_6m_pct"`
	SessionsAvailable int         `json:"sessions_available"`
}

// fs1 is the feature set's parameters (spec.FeatureSpec.Params, whose keys are
// the literals of migration 000130). Each field names its key.
type fs1 struct {
	history        int     // history_calendar_days: the window is [D - history, D]
	minSessions    int     // min_sessions: features exist from this many sessions
	aggSessions    int     // agg_sessions: the rank cap of the aggregates
	priorSessions  int     // breakout_prior_sessions: the prior-high window
	volSessions    int     // breakout_volume_sessions: the prior-volume window
	volMinN        int     // breakout_volume_min_n
	volMultiple    float64 // breakout_volume_multiple
	breakoutWindow int     // breakout_window: ranks 1..n are checked for a breakout
	baseWindow     int     // base_window: the sessions the base is read over
	touch          float64 // touch_ratio: a high within this share of the pivot touches it
	highLow        int     // high_low_sessions: the 52-week range's rank cap
	dvSessions     int     // dv_sessions
	dvMinN         int     // dv_min_n
	avgFrom        int     // avgvol_from: first rank of the average volume
	avgTo          int     // avgvol_to: last rank of the average volume
	avgMinN        int     // avgvol_min_n
	retTolerance   int     // ret_anchor_tolerance_days
	rsTolerance    int     // rs_index_tolerance_days
}

// readFS1 reads every fs1 parameter. A missing key is a programming error (the
// registered specs always carry the full set), so it panics rather than
// computing with a guessed window.
func readFS1(p spec.FeatureSpec) fs1 {
	get := func(key string) float64 {
		v, ok := p.Params[key]
		if !ok {
			panic("features: fs1 parameter " + key + " is missing from the feature spec")
		}
		return v
	}
	i := func(key string) int { return int(get(key)) }
	return fs1{
		history:        i("history_calendar_days"),
		minSessions:    i("min_sessions"),
		aggSessions:    i("agg_sessions"),
		priorSessions:  i("breakout_prior_sessions"),
		volSessions:    i("breakout_volume_sessions"),
		volMinN:        i("breakout_volume_min_n"),
		volMultiple:    get("breakout_volume_multiple"),
		breakoutWindow: i("breakout_window"),
		baseWindow:     i("base_window"),
		touch:          get("touch_ratio"),
		highLow:        i("high_low_sessions"),
		dvSessions:     i("dv_sessions"),
		dvMinN:         i("dv_min_n"),
		avgFrom:        i("avgvol_from"),
		avgTo:          i("avgvol_to"),
		avgMinN:        i("avgvol_min_n"),
		retTolerance:   i("ret_anchor_tolerance_days"),
		rsTolerance:    i("rs_index_tolerance_days"),
	}
}

// Fixed windows of 000130 that the spec does not parameterise: the moving
// averages and the 200-session average one month back.
var smaWindows = [...]int{10, 20, 50, 150, 200}

const (
	sma200LagFrom = 22  // sma200_1m_ago covers ranks 22..221
	sma200LagTo   = 221 // (the average as of 21 sessions ago)
)

// AsOf computes the price features of one stock at session D, from its bars
// (any order is not allowed: ascending by date, unique dates) and the XJO
// series. It is the exact port of mv_price_features evaluated at D instead of
// CURRENT_DATE. Bars after D are ignored, so AsOf(bars[:i+1], d_i) equals
// AsOf(bars, d_i). ok is false when the stock has fewer than min_sessions bars
// in the window.
//
// The newest bar in the window (rank 1) is the feature date; it can be before D
// when the stock did not trade on D. Calls are pure and allocate only the window.
func AsOf(bars []Bar, xjo []IndexBar, D civil.Date, p spec.FeatureSpec) (PriceFeatures, bool) {
	f := readFS1(p)

	from := windowStart(D, f.history)
	w := make([]pt, 0, len(bars))
	for i := range bars {
		b := &bars[i]
		if b.Date.Before(from) || b.Date.After(D) || !validPrice(b.Close) {
			continue
		}
		w = append(w, stockPoint(*b))
	}
	n := len(w)
	if n < f.minSessions {
		return PriceFeatures{}, false
	}

	// Rank r is the r-th newest bar (rank 1 is the feature date).
	at := func(rank int) *pt { return &w[n-rank] }

	// breakoutAt is the views' is_breakout for the bar at rank r: a close above
	// the highest high of the prior baseWindow bars, on at least 1.5x the
	// average volume of the prior volume window. The prior windows stay inside
	// the window (fewer bars before the first one means no breakout there).
	breakoutAt := func(rank int) bool {
		i := n - rank
		if i < f.priorSessions {
			return false
		}
		priorHigh := math.Inf(-1)
		for j := i - f.priorSessions; j < i; j++ {
			if w[j].high > priorHigh {
				priorHigh = w[j].high
			}
		}
		if !(w[i].close > priorHigh) {
			return false
		}
		vn := min(f.volSessions, i)
		if vn < f.volMinN {
			return false
		}
		sum := 0.0
		for j := i - vn; j < i; j++ {
			sum += w[j].volume
		}
		avg := sum / float64(vn)
		if !(avg > 0) {
			return false
		}
		return w[i].volume >= f.volMultiple*avg
	}

	// The breakouts in the newest breakoutWindow ranks. breakout_date is the
	// latest; the base anchor is the earliest (the largest rank), so the two are
	// read in opposite directions and never merged.
	breakouts := make([]bool, f.breakoutWindow+1)
	breakoutRecent := false
	var breakoutDate *civil.Date
	for rank := 1; rank <= f.breakoutWindow; rank++ {
		breakouts[rank] = breakoutAt(rank)
		if breakouts[rank] {
			breakoutRecent = true
			if breakoutDate == nil {
				d := at(rank).date
				breakoutDate = &d
			}
		}
	}
	anchorRank := 1
	for rank := f.breakoutWindow; rank >= 1; rank-- {
		if breakouts[rank] {
			anchorRank = rank
			break
		}
	}

	// The base, described at the anchor session: the pivot is the anchor's prior
	// high (only with a full prior window), the base low and length read the
	// sessions after the anchor.
	anchorIdx := n - anchorRank
	var pivot *float64
	if anchorIdx >= f.priorSessions {
		h := math.Inf(-1)
		for j := anchorIdx - f.priorSessions; j < anchorIdx; j++ {
			if w[j].high > h {
				h = w[j].high
			}
		}
		pivot = &h
	}
	var baseLow *float64
	if n >= anchorRank+f.baseWindow {
		lo := math.Inf(1)
		for rank := anchorRank + 1; rank <= anchorRank+f.baseWindow; rank++ {
			lo = math.Min(lo, at(rank).low)
		}
		baseLow = &lo
	}
	var baseLength *int
	if pivot != nil {
		for rank := anchorRank + f.baseWindow; rank > anchorRank; rank-- {
			if at(rank).high >= f.touch*(*pivot) {
				length := rank - anchorRank
				baseLength = &length
				break
			}
		}
	}
	var baseDepth *float64
	if pivot != nil && *pivot > 0 && baseLow != nil {
		d := (*pivot - *baseLow) / *pivot * 100
		baseDepth = &d
	}

	// Aggregates over the newest agg_sessions ranks.
	last := at(1).close
	prevClose := at(2).close
	mean := func(from, to int, value func(*pt) float64) float64 {
		sum := 0.0
		for rank := from; rank <= to; rank++ {
			sum += value(at(rank))
		}
		return sum / float64(to-from+1)
	}
	closeOf := func(p *pt) float64 { return p.close }

	var smas [len(smaWindows)]*float64
	for k, size := range smaWindows {
		if n >= size {
			v := mean(1, size, closeOf)
			smas[k] = &v
		}
	}
	var sma200Lag *float64
	if n >= sma200LagTo {
		v := mean(sma200LagFrom, sma200LagTo, closeOf)
		sma200Lag = &v
	}

	high52 := math.Inf(-1)
	low52 := math.Inf(1)
	for rank := 1; rank <= min(n, f.highLow); rank++ {
		high52 = math.Max(high52, at(rank).high)
		low52 = math.Min(low52, at(rank).low)
	}
	var pctOff, pctAbove *float64
	if high52 > 0 {
		v := math.Min(0, (last-high52)/high52*100)
		pctOff = &v
	}
	if low52 > 0 {
		v := math.Max(0, (last-low52)/low52*100)
		pctAbove = &v
	}
	volume := at(1).volume

	var avgVolume, volumeRatio *float64
	if cnt := min(f.avgTo, n) - f.avgFrom + 1; cnt >= f.avgMinN && n >= f.avgFrom {
		v := mean(f.avgFrom, min(f.avgTo, n), func(p *pt) float64 { return p.volume })
		avgVolume = &v
		if v > 0 {
			r := volume / v
			volumeRatio = &r
		}
	}
	var dollarVolume *float64
	if cnt := min(f.dvSessions, n); cnt >= f.dvMinN {
		sum := 0.0
		for rank := 1; rank <= cnt; rank++ {
			sum += at(rank).close * at(rank).volume
		}
		v := sum / float64(cnt)
		dollarVolume = &v
	}

	// Calendar returns, each against the last session on or before its
	// calendar anchor, and RS against the XJO over the same two dates.
	asOf := at(1).date
	ret1, _, _, _ := calendarReturn(w, asOf, 1, f.retTolerance, last)
	ret3, d3, _, ok3 := calendarReturn(w, asOf, 3, f.retTolerance, last)
	ret6, d6, _, ok6 := calendarReturn(w, asOf, 6, f.retTolerance, last)
	ret12, _, _, _ := calendarReturn(w, asOf, 12, f.retTolerance, last)

	out := PriceFeatures{
		AsOf:              asOf,
		Close:             last,
		PrevClose:         &prevClose,
		SMA10:             smas[0],
		SMA20:             smas[1],
		SMA50:             smas[2],
		SMA150:            smas[3],
		SMA200:            smas[4],
		SMA200OneMonthAgo: sma200Lag,
		PctOff52wHigh:     pctOff,
		PctAbove52wLow:    pctAbove,
		Volume:            volume,
		AvgVolume50d:      avgVolume,
		VolumeRatio50d:    volumeRatio,
		DollarVolume20d:   dollarVolume,
		BaseHigh:          pivot,
		BaseLow:           baseLow,
		BaseDepthPct:      baseDepth,
		BaseLengthDays:    baseLength,
		BreakoutRecent:    breakoutRecent,
		BreakoutDate:      breakoutDate,
		Ret1mPct:          ret1,
		Ret3mPct:          ret3,
		Ret6mPct:          ret6,
		Ret12mPct:         ret12,
		SessionsAvailable: min(n, f.aggSessions),
	}
	out.High52w = &high52
	out.Low52w = &low52
	out.RS3mPct = relativeStrength(ret3, d3, ok3, asOf, xjo, f.rsTolerance)
	out.RS6mPct = relativeStrength(ret6, d6, ok6, asOf, xjo, f.rsTolerance)
	return out, true
}

// relativeStrength is the views' rs_<N>m_pct: the stock's N-month return less
// the XJO's return between the same two dates. The XJO close used for each end
// is the last usable one on or before that date, and each must be within the
// tolerance of its date (a gap in the index is not a return). ret is nil when
// the stock has no return, and the RS is then nil too.
func relativeStrength(ret *float64, anchor civil.Date, anchored bool, asOf civil.Date, xjo []IndexBar, tolerance int) *float64 {
	if ret == nil || !anchored {
		return nil
	}
	end, okEnd := lastUsableIndex(xjo, asOf)
	start, okStart := lastUsableIndex(xjo, anchor)
	if !okEnd || !okStart {
		return nil
	}
	if end.Date.Before(asOf.AddDays(-tolerance)) || start.Date.Before(anchor.AddDays(-tolerance)) {
		return nil
	}
	v := *ret - (end.Close/start.Close-1)*100
	return &v
}

// lastUsableIndex returns the newest index bar dated on or before target whose
// close is usable, searching xjo (ascending by date) from the end.
func lastUsableIndex(xjo []IndexBar, target civil.Date) (IndexBar, bool) {
	lo, hi := 0, len(xjo)
	for lo < hi {
		mid := (lo + hi) / 2
		if xjo[mid].Date.After(target) {
			hi = mid
		} else {
			lo = mid + 1
		}
	}
	for i := lo - 1; i >= 0; i-- {
		if indexUsable(xjo[i].Close) {
			return xjo[i], true
		}
	}
	return IndexBar{}, false
}
