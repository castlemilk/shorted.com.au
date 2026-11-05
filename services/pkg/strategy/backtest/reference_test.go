package backtest

import (
	"math"
	"testing"
	"time"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
)

// monthSessions are the weekdays from start on, in order: a stand-in calendar for
// the reference fixtures, which need no holidays.
func monthSessions(start civil.Date, n int) []civil.Date {
	var out []civil.Date
	for d := start; len(out) < n; d = d.AddDays(1) {
		if wd := weekday(d); wd != time.Saturday && wd != time.Sunday {
			out = append(out, d)
		}
	}
	return out
}

func weekday(d civil.Date) time.Weekday {
	return time.Date(d.Year, time.Month(d.Month), d.Day, 0, 0, 0, 0, time.UTC).Weekday()
}

// flatTrack is a code priced at prices on the sessions, with no dividends and the
// multiplier at one.
func flatTrack(prices ...float64) refTrack {
	n := len(prices)
	tr := refTrack{pl: make([]float64, n), mult: make([]float64, n), div: make([]float64, n)}
	for k, p := range prices {
		tr.pl[k] = p
		tr.mult[k] = 1
	}
	return tr
}

// TestReferenceIsMonthlyEqualWeight: on the first session of each month the
// reference splits its equity equally across its members at the close, holds
// them to the next month, and pays no costs. The equity is unchanged by the
// rebalance itself.
func TestReferenceIsMonthlyEqualWeight(t *testing.T) {
	sessions := monthSessions(civil.Date{Year: 2024, Month: 1, Day: 2}, 40)
	var jan, feb []int
	for k, d := range sessions {
		if d.Month == 1 {
			jan = append(jan, k)
		} else if d.Month == 2 {
			feb = append(feb, k)
		}
	}
	n := len(sessions)
	// A rises 10 to 12 across January; B is flat at 20. In February A and B are
	// out and C at 5 is in with D at 8.
	a := make([]float64, n)
	b := make([]float64, n)
	c := make([]float64, n)
	dd := make([]float64, n)
	for k := range sessions {
		a[k], b[k], c[k], dd[k] = 10, 20, 5, 8
		if k > jan[0] {
			a[k] = 10 + 2*float64(k-jan[0])/float64(len(jan)-1)
		}
		if k >= feb[0] {
			a[k], b[k] = 0, 0
		}
	}
	tracks := map[string]refTrack{
		"A": flatTrack(a...), "B": flatTrack(b...), "C": flatTrack(c...), "D": flatTrack(dd...),
	}
	// The A and B tracks are zero from February: they are unpriced, not delisted,
	// and the rebalance at February's first session does not buy them.
	members := func(k int, _ civil.Date) []string {
		if k == jan[0] {
			return []string{"A", "B"}
		}
		return []string{"C", "D"}
	}
	curve := referenceCurve(100000, sessions, tracks, members)

	// The first session: equal weight at the close, equity unchanged.
	if got := curve.Values[jan[0]]; math.Abs(got-100000) > 1e-6 {
		t.Fatalf("equity on the first session %v, want 100000", got)
	}
	// A from 10 to its last January close, B flat at 20: the equity is the mean
	// of the two holdings' growth.
	lastJan := jan[len(jan)-1]
	aEnd := a[lastJan]
	want := 50000*aEnd/10 + 50000*b[lastJan]/20
	if got := curve.Values[lastJan]; math.Abs(got-want) > 1e-6 {
		t.Fatalf("equity at January's last close %v, want %v", got, want)
	}
	// February's first session rebalances to C and D at the close, with no cost.
	if got := curve.Values[feb[0]]; math.Abs(got-want) > 1e-6 {
		t.Fatalf("equity on the rebalance %v, want %v (no cost)", got, want)
	}
}

// TestReferenceExitsADelistedMemberAtItsLastMark: a holding with no priced bar for
// the stale-exit run is sold at its last mark, and the proceeds stay in cash until
// the next rebalance. Before the exit the holding marks at its last close, so the
// equity is unchanged by the exit itself.
func TestReferenceExitsADelistedMemberAtItsLastMark(t *testing.T) {
	sessions := monthSessions(civil.Date{Year: 2024, Month: 1, Day: 2}, 30)
	n := len(sessions)
	a := make([]float64, n)
	b := make([]float64, n)
	for k := range sessions {
		a[k] = 10
		b[k] = 10 + float64(k) // B rises to 14 by session 4, then stops trading
		if k >= 5 {
			b[k] = 0
		}
	}
	tracks := map[string]refTrack{"A": flatTrack(a...), "B": flatTrack(b...)}
	members := func(k int, _ civil.Date) []string {
		if k == 0 {
			return []string{"A", "B"}
		}
		return nil
	}
	curve := referenceCurve(100000, sessions, tracks, members)
	// A is 5000 units at 10 and B is 5000 units at its price. Its last mark is 14.
	for k := 0; k < n; k++ {
		want := 50000 + 5000*b[k]
		if k >= 5 {
			want = 50000 + 5000*14
		}
		if math.Abs(curve.Values[k]-want) > 1e-6 {
			t.Fatalf("session %d equity %v, want %v", k, curve.Values[k], want)
		}
	}
}

// TestReferenceCreditsCashDividendsOnItsHoldings: a cash dividend on an unadjusted
// ex-date adds the dividend times the shares held, on the multiplier of that
// session.
func TestReferenceCreditsCashDividendsOnItsHoldings(t *testing.T) {
	sessions := monthSessions(civil.Date{Year: 2024, Month: 1, Day: 2}, 5)
	a := flatTrack(10, 10, 10, 10, 10)
	a.div[2] = 0.5
	members := func(k int, _ civil.Date) []string {
		if k == 0 {
			return []string{"A"}
		}
		return nil
	}
	curve := referenceCurve(100000, sessions, map[string]refTrack{"A": a}, members)
	// 100000 at 10 is 10000 shares; a 0.5 dividend is 5000 in cash from session 2.
	if got := curve.Values[2]; math.Abs(got-105000) > 1e-6 {
		t.Fatalf("equity after the dividend %v, want 105000", got)
	}
}

// TestTrackOfStepsOnTotalReturnBarsOnly: a total-return bar steps the multiplier
// by its adjustment. A bar a cash dividend is credited on (unadjusted, with the
// dividend on it) does not step it, because the dividend is the adjustment.
func TestTrackOfStepsOnTotalReturnBarsOnly(t *testing.T) {
	sessions := monthSessions(civil.Date{Year: 2024, Month: 1, Day: 2}, 3)
	bar := func(k int, close, adj float64) features.Bar {
		return features.Bar{Date: sessions[k], Open: close, High: close, Low: close, Close: close, AdjClose: adj, Volume: 1e6}
	}
	price4dp := civil.Date{Year: 2020, Month: 1, Day: 1}

	// A 2% total-return step on session 1, none on session 2.
	steps := []features.Bar{bar(0, 10, 10), bar(1, 10, 10.2), bar(2, 10, 10.2)}
	tr := trackOf(steps, sessions, []float64{0, 0, 0}, price4dp)
	if math.Abs(tr.mult[1]-1.02) > 1e-9 || math.Abs(tr.mult[2]-1.02) > 1e-9 {
		t.Fatalf("multipliers %v, want the 2%% step held from session 1", tr.mult)
	}

	// An unadjusted bar on session 1 carries a 0.2 dividend in cash; the 2% step
	// on session 2 is still applied.
	cash := []features.Bar{bar(0, 10, 10), bar(1, 10, 10), bar(2, 10, 10.2)}
	tr = trackOf(cash, sessions, []float64{0, 0.2, 0}, price4dp)
	if math.Abs(tr.mult[1]-1) > 1e-9 {
		t.Fatalf("a cash-credited bar stepped the multiplier to %v", tr.mult[1])
	}
	if tr.div[1] != 0.2 {
		t.Fatalf("cash credited on session 1 is %v, want 0.2", tr.div[1])
	}
	if math.Abs(tr.mult[2]-1.02) > 1e-9 {
		t.Fatalf("the following step gave multiplier %v, want 1.02", tr.mult[2])
	}
}
