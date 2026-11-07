package calendar

import (
	"math/rand"
	"sort"
	"testing"
	"time"

	"cloud.google.com/go/civil"
)

// The reference functions below are the calendar's answers as they were before
// the prefix counts: they are the oracle the precomputed answers must match.

func refIsSession(c *Calendar, d civil.Date) bool {
	switch {
	case c.hasReport && !d.After(c.lastReport):
		return c.index[d] && c.asic[d]
	case c.hasIndex && !d.After(c.newestIndex):
		return c.index[d] && tradingDay(d)
	default:
		return tradingDay(d)
	}
}

func refPublishedOn(c *Calendar, reportDate civil.Date) (civil.Date, bool) {
	if c.lag == 0 {
		return reportDate, true
	}
	d := reportDate
	sessions := 0
	for n := 0; n < maxLagDays; n++ {
		d = d.AddDays(1)
		if refIsSession(c, d) {
			sessions++
			if sessions == c.lag {
				return d, true
			}
		}
	}
	return civil.Date{}, false
}

func refSessionsBetween(c *Calendar, from, to civil.Date) int {
	n := 0
	for d := from.AddDays(1); !d.After(to); d = d.AddDays(1) {
		if refIsSession(c, d) {
			n++
		}
	}
	return n
}

// scenario is one calendar input: the index and ASIC dates it is built from.
type scenario struct {
	name  string
	index []civil.Date
	asic  []civil.Date
	lag   int
}

func randomWeekdays(r *rand.Rand, first, last civil.Date, skipPct int) []civil.Date {
	var out []civil.Date
	for d := first; !d.After(last); d = d.AddDays(1) {
		if d.Weekday() == time.Saturday || d.Weekday() == time.Sunday {
			continue
		}
		if r.Intn(100) < skipPct {
			continue
		}
		out = append(out, d)
	}
	return out
}

func randomScenarios(r *rand.Rand) []scenario {
	first := civil.Date{Year: 2019, Month: time.March, Day: 1}
	last := civil.Date{Year: 2026, Month: time.November, Day: 20}
	base := randomWeekdays(r, first, last, 2) // a few missing index bars
	var out []scenario
	for i := 0; i < 24; i++ {
		var index []civil.Date
		for _, d := range base {
			if r.Intn(100) < 1 {
				continue // a gap in the index
			}
			if r.Intn(100) < 3 {
				d = d.AddDays(-1) // a DST-shifted (UTC-stored) date
			}
			index = append(index, d)
		}
		// Duplicates and an unordered feed.
		index = append(index, index[:len(index)/10]...)
		r.Shuffle(len(index), func(a, b int) { index[a], index[b] = index[b], index[a] })

		var asic []civil.Date
		end := last
		if i%3 == 0 {
			end = civil.Date{Year: 2026, Month: time.August, Day: 1 + r.Intn(28)}
		}
		for _, d := range base {
			if d.After(end) {
				break
			}
			if r.Intn(100) < 5 {
				continue // a missing ASIC report
			}
			asic = append(asic, d)
		}
		for k := 0; k < 4; k++ {
			// Reports dated on weekends and holidays.
			asic = append(asic, first.AddDays(r.Intn(2500)))
		}
		r.Shuffle(len(asic), func(a, b int) { asic[a], asic[b] = asic[b], asic[a] })
		lag := []int{0, 4}[i%2]
		out = append(out, scenario{name: "mixed", index: index, asic: asic, lag: lag})
	}
	// Edge shapes: empty, index only, ASIC only, one of each.
	out = append(out,
		scenario{name: "empty", lag: 4},
		scenario{name: "index-only", index: base, lag: 4},
		scenario{name: "index-only-lag0", index: base, lag: 0},
		scenario{name: "asic-only", asic: base[:300], lag: 4},
		scenario{name: "one-each", index: base[:1], asic: base[5:6], lag: 4},
	)
	return out
}

// probeDates are the dates a scenario is checked on: every day across its
// data, a margin each side, and random dates well outside it.
func probeDates(r *rand.Rand, c *Calendar, index, asic []civil.Date) []civil.Date {
	var lo, hi civil.Date
	all := append(append([]civil.Date{}, index...), asic...)
	if len(all) == 0 {
		lo = civil.Date{Year: 2000, Month: time.January, Day: 1}
		hi = civil.Date{Year: 2001, Month: time.January, Day: 1}
	} else {
		sort.Slice(all, func(i, j int) bool { return all[i].Before(all[j]) })
		lo, hi = all[0], all[len(all)-1]
	}
	var out []civil.Date
	for d := lo.AddDays(-12); !d.After(hi.AddDays(12)); d = d.AddDays(1) {
		out = append(out, d)
	}
	for k := 0; k < 300; k++ {
		out = append(out, lo.AddDays(r.Intn(4000)-2000))
	}
	return out
}

func TestRangeEquivalenceRandom(t *testing.T) {
	r := rand.New(rand.NewSource(20261108))
	for si, sc := range randomScenarios(r) {
		c := New(sc.index, sc.asic, sc.lag)
		if c.ranged != (len(sc.index)+len(sc.asic) > 0) {
			t.Fatalf("scenario %d (%s): ranged = %v", si, sc.name, c.ranged)
		}
		probes := probeDates(r, c, sc.index, sc.asic)

		for _, d := range probes {
			if got, want := c.IsSession(d), refIsSession(c, d); got != want {
				t.Fatalf("scenario %d (%s): IsSession(%v) = %v, want %v", si, sc.name, d, got, want)
			}
			gotP, gotOK := c.PublishedOn(d)
			wantP, wantOK := refPublishedOn(c, d)
			if gotP != wantP || gotOK != wantOK {
				t.Fatalf("scenario %d (%s): PublishedOn(%v) = %v,%v want %v,%v", si, sc.name, d, gotP, gotOK, wantP, wantOK)
			}
		}

		// SessionsBetween over random pairs, both directions, spans that cross lo
		// and hi, and from/to before and after the data.
		for k := 0; k < 4000; k++ {
			from := probes[r.Intn(len(probes))]
			to := probes[r.Intn(len(probes))]
			if k%4 == 0 {
				to = from.AddDays(r.Intn(60))
			}
			if got, want := c.SessionsBetween(from, to), refSessionsBetween(c, from, to); got != want {
				t.Fatalf("scenario %d (%s): SessionsBetween(%v, %v) = %d, want %d", si, sc.name, from, to, got, want)
			}
		}
	}
}

func TestRangeEquivalenceAroundBounds(t *testing.T) {
	// From and to on, just before and just after the precomputed range, with a
	// span covering all of it, for a fixed realistic calendar.
	first := civil.Date{Year: 2019, Month: time.April, Day: 1}
	last := civil.Date{Year: 2026, Month: time.October, Day: 30}
	r := rand.New(rand.NewSource(7))
	index := randomWeekdays(r, first, last, 1)
	asic := append([]civil.Date{}, index[:len(index)-30]...)
	c := New(index, asic, 4)
	if !c.ranged {
		t.Fatal("expected a precomputed range")
	}
	lo := civilFromDays(c.loNum)
	hi := civilFromDays(c.hiNum)
	points := []civil.Date{}
	for _, anchor := range []civil.Date{lo, hi} {
		for k := -3; k <= 3; k++ {
			points = append(points, anchor.AddDays(k))
		}
	}
	points = append(points, civil.Date{Year: 1999, Month: time.December, Day: 31}, civil.Date{Year: 2030, Month: time.June, Day: 3})
	for _, from := range points {
		for _, to := range points {
			if got, want := c.SessionsBetween(from, to), refSessionsBetween(c, from, to); got != want {
				t.Fatalf("SessionsBetween(%v, %v) = %d, want %d", from, to, got, want)
			}
		}
		if got, want := c.IsSession(from), refIsSession(c, from); got != want {
			t.Fatalf("IsSession(%v) = %v, want %v", from, got, want)
		}
	}
}

func TestDayNumRoundTrip(t *testing.T) {
	base := civil.Date{Year: -400, Month: time.January, Day: 1}
	for k := int64(0); k < 900000; k += 37 {
		d := civilFromDays(dayNum(base) + k)
		if d != base.AddDays(int(k)) {
			t.Fatalf("civilFromDays(%d) = %v, want %v", k, d, base.AddDays(int(k)))
		}
		if dayNum(d) != dayNum(base)+k {
			t.Fatalf("dayNum(%v) = %d, want %d", d, dayNum(d), dayNum(base)+k)
		}
	}
	for _, d := range []civil.Date{{Year: 1970, Month: time.January, Day: 1}, {Year: 2000, Month: time.February, Day: 29}, {Year: 2026, Month: time.November, Day: 8}} {
		want := civil.DateOf(time.Date(d.Year, d.Month, d.Day, 0, 0, 0, 0, time.UTC))
		if civilFromDays(dayNum(d)) != want {
			t.Fatalf("round trip of %v gave %v", d, civilFromDays(dayNum(d)))
		}
	}
	if dayNum(civil.Date{Year: 1970, Month: time.January, Day: 1}) != 0 {
		t.Fatal("the epoch is day 0")
	}
}
