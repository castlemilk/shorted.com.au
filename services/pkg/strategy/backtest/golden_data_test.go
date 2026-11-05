package backtest

import (
	"fmt"
	"math"
	"math/rand"
	"sort"
	"time"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/asxcalendar"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// The golden dataset is a seeded synthetic market of goldenCodes stocks over
// goldenSessions ASX sessions. It is generated once and committed as CSV under
// testdata/golden; TestGoldenDataIsReproducible holds the committed files to the
// generator. Its scripted events are the ones the publication gates need:
//
//   - codes 0-5 break out of a 40-session base on heavy volume (crowded shorts);
//   - code 6 has a gap of rows and a run of untraded sessions;
//   - code 8 is delisted: no rows after goldenSessions/2+150;
//   - code 9 consolidates 1:10 without adjustment, and the ASIC reports either
//     side of it show the share count stepping down by the same factor;
//   - code 10 is a 2-dp payer priced A$1-2: one cash dividend on an unadjusted
//     ex-date (credited in cash) and one vendor-adjusted (total return);
//   - code 11 pays an adjusted dividend on a A$20 stock;
//   - code 12 carries a k artefact from goldenK: the vendor's adjustment step on
//     one bar, not a return, which must change only that bar.
const (
	goldenSeed     = 20230602
	goldenCodes    = 24
	goldenSessions = 700
	goldenK        = 350
	goldenPrice4dp = "2023-06-01"
	goldenStart    = "2023-01-02"
	// goldenWindow opens the recipe one session after the first, so the first
	// session is the seed the window's entries read.
	goldenWindow = "2023-01-03"
)

// goldenSpec is the crowded-short version the golden run evaluates under: the
// v1 universe and data policy (ordinary shares, the ASIC report of the latest
// complete publication, a four-session publication lag and the corroborated
// corporate-action guard).
func goldenSpec(t interface{ Fatal(...any) }) spec.Spec {
	r, ok := spec.Live(spec.StrategyCrowdedShortBreakout)
	if !ok {
		t.Fatal("no live crowded-short version")
	}
	s := r.Spec
	s.Universe = spec.UniverseSpec{Instruments: "ordinary", Freshness: "bar_on_session", MinSessions: 60, LookbackDays: 400, ASICReported: true, CAGuard: true, RSPopulation: "universe"}
	s.Data = spec.DataPolicy{
		ShortSource: "latest_complete_published", PublicationLagSessions: 4, MaxReportAgeSessions: 8,
		Calendar: "xjo_and_asic_dates", DTC: "v1_20_bars_min10_traded", Absent: "fail", Fundamentals: "live_snapshot",
		Price4dpFrom: goldenPrice4dp, CAUpjumpFrom: "2023-09-01",
	}
	return s
}

// goldenRecipe is the canonical crowded-short recipe with its window opened to
// the whole golden history.
func goldenRecipe(t interface{ Fatal(...any) }) spec.Recipe {
	for _, r := range spec.R1Recipes() {
		if r.StrategyID == spec.StrategyCrowdedShortBreakout {
			r.WindowStart = goldenWindow
			return r
		}
	}
	t.Fatal("no crowded-short recipe")
	return spec.Recipe{}
}

// goldenData is the generated market, before it is written to CSV.
type goldenData struct {
	bars  map[string][]features.Bar
	divs  map[string][]features.Dividend
	mkt   Market
	names map[string]string
	// shortPct is the percentage of issued shares each code reports short.
	shortPct map[string]float64
}

func goldenCode(i int) string { return fmt.Sprintf("GD%02d", i) }

// goldenSessionDates are the ASX trading days from goldenStart.
func goldenSessionDates() []civil.Date {
	var out []civil.Date
	d, _ := civil.ParseDate(goldenStart)
	for len(out) < goldenSessions {
		if asxcalendar.IsTradingDay(time.Date(d.Year, d.Month, d.Day, 0, 0, 0, 0, time.UTC)) {
			out = append(out, d)
		}
		d = d.AddDays(1)
	}
	return out
}

// round4 keeps a value to four decimal places. The generator writes only
// rounded values, so the committed files are the same on every architecture:
// math.Exp and its kin differ in the last bit between amd64 and arm64.
func round4(x float64) float64 { return math.Round(x*10000) / 10000 }

// roundPrice keeps a price to cents before goldenPrice4dp and to four decimal
// places after it, as the stored rows are.
func roundPrice(x float64, d, price4dp civil.Date) float64 {
	if d.Before(price4dp) {
		return math.Round(x*100) / 100
	}
	return math.Round(x*10000) / 10000
}

func buildGolden() goldenData {
	rng := rand.New(rand.NewSource(goldenSeed))
	dates := goldenSessionDates()
	price4dp, _ := civil.ParseDate(goldenPrice4dp)
	g := goldenData{
		bars:     map[string][]features.Bar{},
		divs:     map[string][]features.Dividend{},
		names:    map[string]string{},
		shortPct: map[string]float64{},
	}

	// Market: the index level and the total-return index.
	xjo := make([]features.IndexBar, goldenSessions)
	xjt := make([]features.IndexBar, goldenSessions)
	lvl, tr := 7000.0, 4000.0
	for i, d := range dates {
		if i > 0 {
			r := 0.0004 + 0.008*rng.NormFloat64()
			lvl *= math.Exp(r)
			tr *= math.Exp(r + 0.00012)
		}
		xjo[i] = features.IndexBar{Date: d, High: round4(lvl * 1.004), Low: round4(lvl * 0.996), Close: round4(lvl)}
		xjt[i] = features.IndexBar{Date: d, High: round4(tr * 1.004), Low: round4(tr * 0.996), Close: round4(tr)}
	}
	g.mkt.XJO, g.mkt.XJT = xjo, xjt
	g.mkt.ETPs = map[string]bool{}
	g.mkt.Names = map[string]string{}
	for i := 0; i < goldenCodes; i++ {
		g.names[goldenCode(i)] = fmt.Sprintf("GOLDEN %02d LIMITED", i)
	}
	g.mkt.Names = g.names
	for m, rate := range []float64{4.35, 4.35, 4.35, 4.35, 4.10, 4.10} {
		g.mkt.CashRate = append(g.mkt.CashRate, features.RatePoint{Date: civil.Date{Year: 2023, Month: time.Month(m + 1), Day: 1}, Rate: rate})
	}

	breakouts := map[int]int{0: 120, 1: 260, 2: 520, 3: 180, 4: 300, 5: 600, 7: 190, 8: 485, 9: 410, 10: 100, 11: 280, 12: 345}
	for i := 0; i < goldenCodes; i++ {
		code := goldenCode(i)
		start := 2 + 38*rng.Float64()
		sigma := 0.018 + 0.012*rng.Float64()
		drift := -0.0005 + 0.002*rng.Float64()
		vol := 2e5 + 2e6*rng.Float64()
		if i == 10 {
			start, sigma, drift, vol = 1.5, 0.002, 0.0003, 3e6
		}
		if i == 11 {
			start, sigma, vol = 20, 0.012, 8e5
		}
		shortPct := 1 + 4*rng.Float64()
		if _, ok := breakouts[i]; ok {
			shortPct = 8 + 4*rng.Float64()
		}
		g.shortPct[code] = shortPct

		closes := make([]float64, goldenSessions)
		opens := make([]float64, goldenSessions)
		px := start
		for t := range closes {
			if t > 0 {
				px *= math.Exp(drift + sigma*rng.NormFloat64())
			}
			if b, ok := breakouts[i]; ok && t >= b-45 && t < b {
				px = start * (1 + 0.004*math.Sin(float64(t)))
			}
			if b, ok := breakouts[i]; ok && t == b {
				px *= 1.12
			}
			if b, ok := breakouts[i]; ok && t > b && t <= b+10 {
				px *= 1.005
			}
			closes[t] = px
		}
		if i == 9 {
			for t := 420; t < goldenSessions; t++ {
				closes[t] *= 10
			}
		}
		for t := range closes {
			prev := closes[t]
			if t > 0 {
				prev = closes[t-1]
			}
			opens[t] = prev * math.Exp(0.004*rng.NormFloat64())
		}

		// Vendor adjustment factor: adj = close x a_t. Adjusted dividends and
		// the k artefact move it; an unadjusted dividend leaves it alone.
		a := make([]float64, goldenSessions)
		for t := range a {
			a[t] = 1
		}
		switch i {
		case 11:
			g.addAdjustedDividend(code, dates, closes, a, 300, 0.5)
		case 10:
			g.addAdjustedDividend(code, dates, closes, a, 450, 0.03)
			g.divs[code] = append(g.divs[code], features.Dividend{ExDate: dates[150], AmountPerShare: 0.03})
		case 12:
			for t := goldenK; t < goldenSessions; t++ {
				a[t] *= 1.6
			}
		}

		bars := make([]features.Bar, 0, goldenSessions)
		for t, d := range dates {
			if i == 6 && t >= 200 && t <= 212 {
				continue
			}
			if i == 8 && t > goldenSessions/2+150 {
				break
			}
			c := roundPrice(closes[t], d, price4dp)
			o := roundPrice(opens[t], d, price4dp)
			h := roundPrice(math.Max(o, c)*(1+0.006*math.Abs(rng.NormFloat64())), d, price4dp)
			l := roundPrice(math.Min(o, c)*(1-0.006*math.Abs(rng.NormFloat64())), d, price4dp)
			v := math.Round(vol * math.Exp(0.3*rng.NormFloat64()))
			if _, ok := breakouts[i]; ok && t >= breakouts[i] && t <= breakouts[i]+2 {
				v *= 4
			}
			if (i == 6 && t >= 300 && t < 306) || (i != 10 && i != 11 && rng.Float64() < 0.02) {
				v = 0
			}
			if h < c {
				h = c
			}
			if l > c {
				l = c
			}
			adj := roundPrice(closes[t]*a[t], d, price4dp)
			bars = append(bars, features.Bar{Date: d, Open: o, High: h, Low: l, Close: c, AdjClose: adj, Volume: v})
		}
		g.bars[code] = bars
	}

	// ASIC: a report on every session for every code, so the calendar's
	// sessions are the simulator's. Each report's short percentage varies, so a
	// change to one report can change a later decision. Code 9's share count
	// steps down tenfold with the consolidation, between the reports at 419 and
	// 420.
	for t := 0; t < goldenSessions; t++ {
		d := dates[t]
		for i := 0; i < goldenCodes; i++ {
			code := goldenCode(i)
			issued := 3e8 + float64(i)*1e7
			if i == 9 && t >= 420 {
				issued /= 10
			}
			pct := round4(g.shortPct[code] * (0.7 + 0.6*rng.Float64()))
			if i%4 == 3 {
				pct = 0
			}
			g.mkt.ASIC = append(g.mkt.ASIC, features.ASICRow{
				Code: code, ReportDate: d, Product: fmt.Sprintf("GOLDEN %02d LIMITED ORDINARY FULLY PAID", i),
				Positions: math.Round(issued * pct / 100), Issued: issued, Percent: ptrF(pct),
			})
		}
		fr := goldenCodes
		g.mkt.Ingests = append(g.mkt.Ingests, features.ReportIngest{ReportDate: d, FileRows: &fr, LoadedRows: goldenCodes})
	}
	return g
}

func ptrF(v float64) *float64 { return &v }

// addAdjustedDividend pays a dividend that the vendor adjusts into the history:
// every bar before the ex-date moves by the factor (1 - amount/close before it).
func (g *goldenData) addAdjustedDividend(code string, dates []civil.Date, closes, a []float64, ex int, amount float64) {
	factor := 1 - amount/closes[ex-1]
	for t := 0; t < ex; t++ {
		a[t] *= factor
	}
	g.divs[code] = append(g.divs[code], features.Dividend{ExDate: dates[ex], AmountPerShare: amount})
}

// sortedGoldenCodes lists the generated codes.
func sortedGoldenCodes(m map[string][]features.Bar) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
