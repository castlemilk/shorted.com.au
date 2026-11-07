package features

import (
	"fmt"
	"math"
	"strconv"
	"time"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
)

// The parity comparisons hold the Go port to the views column for column. They
// are shared by the container parity test and the picks job's shadow run, so
// both report the same disagreements in the same words.

// ViewPrice is one row of mv_price_features as the database returns it.
type ViewPrice struct {
	AsOf           time.Time
	Close          float64
	PrevClose      *float64
	SMA10          *float64
	SMA20          *float64
	SMA50          *float64
	SMA150         *float64
	SMA200         *float64
	SMA200Lag      *float64
	High52         *float64
	Low52          *float64
	PctOff         *float64
	PctAbove       *float64
	Volume         int64
	AvgVolume      *float64
	VolumeRatio    *float64
	DollarVolume   *float64
	BaseHigh       *float64
	BaseLow        *float64
	BaseDepth      *float64
	BaseLength     *int32
	BreakoutRecent bool
	BreakoutDate   *time.Time
	Ret1, Ret3     *float64
	Ret6, Ret12    *float64
	RS3, RS6       *float64
	SessionsAvail  int32
}

// ViewRegime is the XJO row of mv_market_regime as the database returns it.
type ViewRegime struct {
	AsOf   *time.Time
	Close  *float64
	SMA50  *float64
	SMA200 *float64
	PctOff *float64
	Ret1   *float64
	Ret3   *float64
	Label  *string
}

// ComparePrice lists every column where the Go port and the view disagree at
// the same session, each as "<column> go <x> view <y>". The float sums of the
// view and the port run in different orders, so floats compare to 1e-9
// relative. An empty list is a match.
func ComparePrice(got PriceFeatures, v ViewPrice) []string {
	var out []string
	add := func(format string, args ...any) { out = append(out, fmt.Sprintf(format, args...)) }
	if want := civil.DateOf(v.AsOf); got.AsOf != want {
		add("as_of go %s view %s", got.AsOf, want)
	}
	if !approx(got.Close, v.Close) {
		add("close go %v view %v", got.Close, v.Close)
	}
	pairs := []struct {
		name string
		g    *float64
		w    *float64
	}{
		{"prev_close", got.PrevClose, v.PrevClose},
		{"sma10", got.SMA10, v.SMA10},
		{"sma20", got.SMA20, v.SMA20},
		{"sma50", got.SMA50, v.SMA50},
		{"sma150", got.SMA150, v.SMA150},
		{"sma200", got.SMA200, v.SMA200},
		{"sma200_1m_ago", got.SMA200OneMonthAgo, v.SMA200Lag},
		{"high_52w", got.High52w, v.High52},
		{"low_52w", got.Low52w, v.Low52},
		{"pct_off_52w_high", got.PctOff52wHigh, v.PctOff},
		{"pct_above_52w_low", got.PctAbove52wLow, v.PctAbove},
		{"avg_volume_50d", got.AvgVolume50d, v.AvgVolume},
		{"volume_ratio_50d", got.VolumeRatio50d, v.VolumeRatio},
		{"dollar_volume_20d", got.DollarVolume20d, v.DollarVolume},
		{"base_high", got.BaseHigh, v.BaseHigh},
		{"base_low", got.BaseLow, v.BaseLow},
		{"base_depth_pct", got.BaseDepthPct, v.BaseDepth},
		{"ret_1m_pct", got.Ret1mPct, v.Ret1},
		{"ret_3m_pct", got.Ret3mPct, v.Ret3},
		{"ret_6m_pct", got.Ret6mPct, v.Ret6},
		{"ret_12m_pct", got.Ret12mPct, v.Ret12},
		{"rs_3m_pct", got.RS3mPct, v.RS3},
		{"rs_6m_pct", got.RS6mPct, v.RS6},
	}
	for _, p := range pairs {
		switch {
		case p.g == nil && p.w == nil:
		case p.g == nil || p.w == nil:
			add("%s go %s view %s", p.name, ptrText(p.g), ptrText(p.w))
		case !approx(*p.g, *p.w):
			add("%s go %v view %v", p.name, *p.g, *p.w)
		}
	}
	if !approx(got.Volume, float64(v.Volume)) {
		add("volume go %v view %v", got.Volume, v.Volume)
	}
	if got.BreakoutRecent != v.BreakoutRecent {
		add("breakout_recent go %v view %v", got.BreakoutRecent, v.BreakoutRecent)
	}
	switch {
	case got.BreakoutDate == nil && v.BreakoutDate == nil:
	case got.BreakoutDate == nil || v.BreakoutDate == nil:
		add("breakout_date go %v view %v", got.BreakoutDate, v.BreakoutDate)
	case *got.BreakoutDate != civil.DateOf(*v.BreakoutDate):
		add("breakout_date go %s view %s", *got.BreakoutDate, civil.DateOf(*v.BreakoutDate))
	}
	switch {
	case got.BaseLengthDays == nil && v.BaseLength == nil:
	case got.BaseLengthDays == nil || v.BaseLength == nil:
		add("base_length_days go %v view %v", got.BaseLengthDays, v.BaseLength)
	case int32(*got.BaseLengthDays) != *v.BaseLength:
		add("base_length_days go %d view %d", *got.BaseLengthDays, *v.BaseLength)
	}
	if int32(got.SessionsAvailable) != v.SessionsAvail {
		add("sessions_available go %d view %d", got.SessionsAvailable, v.SessionsAvail)
	}
	return out
}

// CompareRegime lists the regime columns where the Go port and the view
// disagree, named "regime <column> ...". An empty list is a match.
func CompareRegime(got engine.Regime, v ViewRegime) []string {
	var out []string
	add := func(format string, args ...any) { out = append(out, fmt.Sprintf(format, args...)) }
	switch {
	case v.AsOf == nil || got.AsOf == nil:
		add("regime as_of go %v view %v", got.AsOf, v.AsOf)
	case civil.DateOf(*got.AsOf) != civil.DateOf(*v.AsOf):
		add("regime as_of go %s view %s", civil.DateOf(*got.AsOf), civil.DateOf(*v.AsOf))
	}
	if label := ptrString(v.Label); got.Label != label {
		add("regime label go %q view %q", got.Label, label)
	}
	pairs := []struct {
		name string
		g    *float64
		w    *float64
	}{
		{"close", got.Close, v.Close},
		{"sma50", got.SMA50, v.SMA50},
		{"sma200", got.SMA200, v.SMA200},
		{"pct_off_52w_high", got.PctOff52wHigh, v.PctOff},
		{"ret_1m_pct", got.Ret1mPct, v.Ret1},
		{"ret_3m_pct", got.Ret3mPct, v.Ret3},
	}
	for _, p := range pairs {
		switch {
		case p.g == nil && p.w == nil:
		case p.g == nil || p.w == nil:
			add("regime %s go %s view %s", p.name, ptrText(p.g), ptrText(p.w))
		case !approx(*p.g, *p.w):
			add("regime %s go %v view %v", p.name, *p.g, *p.w)
		}
	}
	return out
}

// approx is true when a and b agree to 1e-9 relative (the parity tolerance).
func approx(a, b float64) bool {
	if a == b {
		return true
	}
	return math.Abs(a-b) <= 1e-9*math.Max(1, math.Max(math.Abs(a), math.Abs(b)))
}

func ptrText(p *float64) string {
	if p == nil {
		return "NULL"
	}
	return strconv.FormatFloat(*p, 'g', -1, 64)
}

func ptrString(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
