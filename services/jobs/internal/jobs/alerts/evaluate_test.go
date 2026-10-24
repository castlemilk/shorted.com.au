package alerts

import (
	"reflect"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
)

// Shorthand for building fixtures. Dates are listed newest first, as the window is.

func fp(v float64) *float64 { return &v }

func mon(scope, target, condition, cadence string, threshold *float64) Monitor {
	return Monitor{
		ID: scope + "-" + target + "-" + condition + "-" + cadence, UserID: "u1", Email: "owner@example.com",
		Scope: scope, Target: target, Condition: condition, Cadence: cadence, Threshold: threshold,
	}
}

func snapOf(dates []Date, rows map[Date]map[string]float64, meta map[string]CompanyInfo) *Snapshot {
	if rows == nil {
		rows = map[Date]map[string]float64{}
	}
	if meta == nil {
		meta = map[string]CompanyInfo{}
	}
	return NewSnapshot(dates, rows, meta)
}

// dailyPlan evaluates one date against the report before it.
func dailyPlan(x, prev Date) Plan {
	return Plan{Daily: []DailyEval{{Date: x, Prev: prev}}}
}

func codesOf(cs []Candidate) []string {
	var out []string
	for _, c := range cs {
		for _, co := range c.Payload.Companies {
			out = append(out, co.Code)
		}
	}
	return out
}

const (
	d0 Date = "2026-10-16"
	d1 Date = "2026-10-15"
	d2 Date = "2026-10-14"
	d3 Date = "2026-10-13"
	d4 Date = "2026-10-12"
	d5 Date = "2026-10-09"
	d6 Date = "2026-10-08"
)

// stockRows builds one code's readings over the window: values[i] is the reading
// on dates[i], and a negative value means the code is absent that day.
func stockRows(dates []Date, code string, values []float64) map[Date]map[string]float64 {
	rows := map[Date]map[string]float64{}
	for i, d := range dates {
		if i >= len(values) || values[i] < 0 {
			continue
		}
		if rows[d] == nil {
			rows[d] = map[string]float64{}
		}
		rows[d][code] = values[i]
	}
	return rows
}

func TestStockAboveCrossing(t *testing.T) {
	dates := []Date{d0, d1, d2, d3, d4, d5, d6}
	cases := []struct {
		name     string
		values   []float64 // newest first
		fires    bool
		latest   float64
		previous float64
	}{
		{"upward cross 4.80 -> 5.20", []float64{5.20, 4.80}, true, 5.20, 4.80},
		{"latest equal to threshold fires after a below reading", []float64{5.00, 4.99}, true, 5.00, 4.99},
		{"already above at both dates does not fire", []float64{5.50, 5.20}, false, 0, 0},
		{"equal at both dates does not fire", []float64{5.00, 5.00}, false, 0, 0},
		{"a fall does not fire", []float64{4.90, 5.20}, false, 0, 0},
		{"no previous reading does not fire", []float64{5.20, -1}, false, 0, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			snap := snapOf(dates, stockRows(dates, "BHP", tc.values), nil)
			m := mon(alertevents.ScopeStock, "BHP", alertevents.ConditionShortInterestAbove, alertevents.CadenceDaily, fp(5))
			got := Evaluate([]Monitor{m}, snap, dailyPlan(d0, d1))
			if (len(got) == 1) != tc.fires {
				t.Fatalf("fired=%v, want %v (%+v)", len(got) == 1, tc.fires, got)
			}
			if tc.fires && (*got[0].Previous != tc.previous || *got[0].Latest != tc.latest) {
				t.Fatalf("readings = %v -> %v, want %v -> %v", *got[0].Previous, *got[0].Latest, tc.previous, tc.latest)
			}
		})
	}
}

func TestStockRisesRule(t *testing.T) {
	dates := []Date{d0, d1, d2, d3}
	cases := []struct {
		name   string
		values []float64
		fires  bool
	}{
		{"rise of exactly the threshold fires", []float64{6.30, 5.30}, true},
		{"rise of 0.99 does not fire at 1 point", []float64{6.29, 5.30}, false},
		{"rounding: 5.30 - 4.30 is one full point", []float64{5.30, 4.30}, true},
		{"a fall never fires", []float64{4.30, 5.30}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			snap := snapOf(dates, stockRows(dates, "BHP", tc.values), nil)
			m := mon(alertevents.ScopeStock, "BHP", alertevents.ConditionShortInterestRises, alertevents.CadenceDaily, fp(1))
			got := Evaluate([]Monitor{m}, snap, dailyPlan(d0, d1))
			if (len(got) == 1) != tc.fires {
				t.Fatalf("fired=%v, want %v", len(got) == 1, tc.fires)
			}
		})
	}
}

func TestPreviousReadingComesFromLookback(t *testing.T) {
	dates := []Date{d0, d1, d2, d3, d4, d5, d6}
	// Absent at the previous two reports, present three reports back at 4.00.
	snap := snapOf(dates, stockRows(dates, "BHP", []float64{5.20, -1, -1, 4.00, 3.00, 3.00, 3.00}), nil)
	m := mon(alertevents.ScopeStock, "BHP", alertevents.ConditionShortInterestAbove, alertevents.CadenceDaily, fp(5))
	got := Evaluate([]Monitor{m}, snap, dailyPlan(d0, d1))
	if len(got) != 1 || *got[0].Previous != 4.00 {
		t.Fatalf("want previous 4.00 from three reports back, got %+v", got)
	}
}

func TestNoPreviousWithinFiveReportsDoesNotFire(t *testing.T) {
	dates := []Date{d0, d1, d2, d3, d4, d5, d6}
	// Present only six reports back, which is outside the five-date lookback.
	snap := snapOf(dates, stockRows(dates, "BHP", []float64{5.20, -1, -1, -1, -1, -1, 4.00}), nil)
	m := mon(alertevents.ScopeStock, "BHP", alertevents.ConditionShortInterestAbove, alertevents.CadenceDaily, fp(5))
	if got := Evaluate([]Monitor{m}, snap, dailyPlan(d0, d1)); len(got) != 0 {
		t.Fatalf("a reading beyond the lookback must not fire: %+v", got)
	}
}

func TestCodeAbsentAtLatestDoesNotFire(t *testing.T) {
	dates := []Date{d0, d1}
	snap := snapOf(dates, stockRows(dates, "BHP", []float64{-1, 6.00}), nil)
	m := mon(alertevents.ScopeStock, "BHP", alertevents.ConditionShortInterestAbove, alertevents.CadenceDaily, fp(5))
	if got := Evaluate([]Monitor{m}, snap, dailyPlan(d0, d1)); len(got) != 0 {
		t.Fatalf("a code absent at the latest report cannot fire: %+v", got)
	}
}

// materialsMeta puts codes into Materials, plus a second spelling of an
// industry and a placeholder, to exercise slug matching.
func materialsMeta(codes ...string) map[string]CompanyInfo {
	meta := map[string]CompanyInfo{}
	for _, c := range codes {
		meta[c] = CompanyInfo{Name: "Company " + c, Industry: "Materials"}
	}
	return meta
}

func TestIndustryAboveAndRisesEvaluateConstituents(t *testing.T) {
	dates := []Date{d0, d1}
	rows := map[Date]map[string]float64{
		d0: {"AAA": 5.20, "BBB": 6.50, "EEE": 5.00, "FFF": 1.00, "ZZZ": 2.00, "GGG": 3.00},
		d1: {"AAA": 4.80, "BBB": 6.00, "EEE": 4.99, "FFF": 4.00, "GGG": 1.50},
	}
	meta := materialsMeta("AAA", "BBB", "EEE", "FFF", "ZZZ", "GGG")
	snap := snapOf(dates, rows, meta)

	above := mon(alertevents.ScopeIndustry, "Materials", alertevents.ConditionShortInterestAbove, alertevents.CadenceDaily, fp(5))
	got := Evaluate([]Monitor{above}, snap, dailyPlan(d0, d1))
	if len(got) != 1 {
		t.Fatalf("want one event, got %d", len(got))
	}
	if want := []string{"AAA", "EEE"}; !reflect.DeepEqual(codesOf(got), want) {
		t.Fatalf("crossers = %v, want %v (sorted by latest desc)", codesOf(got), want)
	}
	if got[0].Latest != nil || got[0].Previous != nil {
		t.Fatal("industry events carry no stock-scope readings")
	}
	if got[0].Payload.CompaniesTotal != 2 {
		t.Fatalf("companies_total = %d", got[0].Payload.CompaniesTotal)
	}

	rises := mon(alertevents.ScopeIndustry, "Materials", alertevents.ConditionShortInterestRises, alertevents.CadenceDaily, fp(1))
	got = Evaluate([]Monitor{rises}, snap, dailyPlan(d0, d1))
	if want := []string{"GGG"}; !reflect.DeepEqual(codesOf(got), want) {
		t.Fatalf("risers = %v, want %v (FFF falls, ZZZ has no previous reading, GGG rises 1.50)", codesOf(got), want)
	}
}

func TestIndustryRisesSortedByChange(t *testing.T) {
	dates := []Date{d0, d1}
	rows := map[Date]map[string]float64{
		d0: {"AAA": 6.00, "BBB": 9.00},
		d1: {"AAA": 4.00, "BBB": 5.00},
	}
	snap := snapOf(dates, rows, materialsMeta("AAA", "BBB"))
	m := mon(alertevents.ScopeIndustry, "Materials", alertevents.ConditionShortInterestRises, alertevents.CadenceDaily, fp(1))
	got := Evaluate([]Monitor{m}, snap, dailyPlan(d0, d1))
	if want := []string{"BBB", "AAA"}; !reflect.DeepEqual(codesOf(got), want) {
		t.Fatalf("order = %v, want %v (change 4.00 before 2.00)", codesOf(got), want)
	}
	if c := got[0].Payload.Companies[0]; c.Change == nil || *c.Change != 4.00 {
		t.Fatalf("change not carried: %+v", c)
	}
}

func TestIndustrySlugMatchingAndPlaceholders(t *testing.T) {
	dates := []Date{d0, d1}
	rows := map[Date]map[string]float64{
		d0: {"AAA": 6.00, "BBB": 6.00, "CCC": 6.00},
		d1: {"AAA": 1.00, "BBB": 1.00, "CCC": 1.00},
	}
	meta := map[string]CompanyInfo{
		"AAA": {Name: "Aaa", Industry: "Health Care Equipment & Services"},
		"BBB": {Name: "Bbb", Industry: "Not Applic"},
		"CCC": {Name: "Ccc", Industry: "Other"},
	}
	snap := snapOf(dates, rows, meta)

	hc := mon(alertevents.ScopeIndustry, "health care equipment services", alertevents.ConditionShortInterestAbove, alertevents.CadenceDaily, fp(5))
	if got := codesOf(Evaluate([]Monitor{hc}, snap, dailyPlan(d0, d1))); !reflect.DeepEqual(got, []string{"AAA"}) {
		t.Fatalf("slug match = %v, want [AAA]", got)
	}
	// Placeholder industries never match, even a target spelled the same way.
	other := mon(alertevents.ScopeIndustry, "Other", alertevents.ConditionShortInterestAbove, alertevents.CadenceDaily, fp(5))
	if got := Evaluate([]Monitor{other}, snap, dailyPlan(d0, d1)); len(got) != 0 {
		t.Fatalf("a placeholder target must never fire: %+v", got)
	}
	na := mon(alertevents.ScopeIndustry, "Not Applic", alertevents.ConditionShortInterestAbove, alertevents.CadenceDaily, fp(5))
	if got := Evaluate([]Monitor{na}, snap, dailyPlan(d0, d1)); len(got) != 0 {
		t.Fatalf("Not Applic must never match: %+v", got)
	}
}

func TestTopTenEntrantAndRanks(t *testing.T) {
	// Ten codes F01..F10 hold the top ten on d1 (F01 highest). On d0, F11 at 11.0 is
	// new to the top ten and F10 drops out. Only F11 is an entrant.
	dates := []Date{d0, d1}
	prev := map[string]float64{}
	meta := map[string]CompanyInfo{}
	for i := 1; i <= 10; i++ {
		code := "F" + pad2(i)
		prev[code] = float64(11 - i)
		meta[code] = CompanyInfo{Name: code, Industry: "Materials"}
	}
	cur := map[string]float64{"F11": 11.0}
	for i := 1; i <= 9; i++ {
		code := "F" + pad2(i)
		cur[code] = float64(11 - i)
	}
	meta["F11"] = CompanyInfo{Name: "F11", Industry: "Materials"}
	snap := snapOf(dates, map[Date]map[string]float64{d0: cur, d1: prev}, meta)

	m := mon(alertevents.ScopeIndustry, "Materials", alertevents.ConditionNewTopTenEntry, alertevents.CadenceDaily, nil)
	got := Evaluate([]Monitor{m}, snap, dailyPlan(d0, d1))
	if len(got) != 1 {
		t.Fatalf("want one event, got %+v", got)
	}
	cs := got[0].Payload.Companies
	if len(cs) != 1 || cs[0].Code != "F11" || cs[0].Rank != 1 || cs[0].PreviousRank != 0 || cs[0].Previous != nil {
		t.Fatalf("entrant = %+v, want F11 rank 1, not ranked before, no previous reading", cs)
	}
}

func TestTopTenTieBrokenByCode(t *testing.T) {
	dates := []Date{d0, d1}
	rows := map[Date]map[string]float64{
		d0: {"ZZZ": 8.0, "AAA": 8.0, "MMM": 8.0},
		d1: {"MMM": 8.0},
	}
	snap := snapOf(dates, rows, materialsMeta("AAA", "MMM", "ZZZ"))
	m := mon(alertevents.ScopeIndustry, "Materials", alertevents.ConditionNewTopTenEntry, alertevents.CadenceDaily, nil)
	got := Evaluate([]Monitor{m}, snap, dailyPlan(d0, d1))
	if len(got) != 1 {
		t.Fatalf("want one event")
	}
	var codes []string
	for _, c := range got[0].Payload.Companies {
		codes = append(codes, c.Code)
	}
	if want := []string{"AAA", "ZZZ"}; !reflect.DeepEqual(codes, want) {
		t.Fatalf("entrants %v, want %v: ties by code ascending, MMM already ranked", codes, want)
	}
	// Ranks at d0 are AAA 1, MMM 2, ZZZ 3. MMM was already ranked, so the entrants
	// keep their ranks at d0.
	if got[0].Payload.Companies[0].Rank != 1 || got[0].Payload.Companies[1].Rank != 3 {
		t.Fatalf("ranks wrong: %+v", got[0].Payload.Companies)
	}
}

func TestTopTenSmallIndustryRanksEveryCompany(t *testing.T) {
	dates := []Date{d0, d1}
	rows := map[Date]map[string]float64{
		d0: {"AAA": 3.0, "BBB": 2.0, "CCC": 1.0},
		d1: {"AAA": 3.0, "BBB": 2.0},
	}
	snap := snapOf(dates, rows, materialsMeta("AAA", "BBB", "CCC"))
	m := mon(alertevents.ScopeIndustry, "Materials", alertevents.ConditionNewTopTenEntry, alertevents.CadenceDaily, nil)
	got := Evaluate([]Monitor{m}, snap, dailyPlan(d0, d1))
	if len(got) != 1 || len(got[0].Payload.Companies) != 1 || got[0].Payload.Companies[0].Code != "CCC" {
		t.Fatalf("CCC enters a three-company industry: %+v", got)
	}
	if got[0].Payload.Companies[0].Rank != 3 {
		t.Fatalf("CCC rank = %d, want 3", got[0].Payload.Companies[0].Rank)
	}
}

func TestPlanRunDailyBacklogCapKeepsNewest(t *testing.T) {
	dates := []Date{"2026-10-20", "2026-10-19", "2026-10-16", "2026-10-15", "2026-10-14", "2026-10-13", "2026-10-12", "2026-10-09"}
	snap := snapOf(dates, nil, nil)
	plan := PlanRun(State{DailyThrough: "2026-10-09", WeeklyThrough: "2026-10-09"}, snap)
	if len(plan.Daily) != 1 || plan.Daily[0].Date != "2026-10-20" || plan.Daily[0].Prev != "2026-10-19" {
		t.Fatalf("daily = %+v, want only the newest date", plan.Daily)
	}
	if plan.DailySkipped != 6 {
		t.Fatalf("skipped = %d, want 6", plan.DailySkipped)
	}
	if plan.Next.DailyThrough != "2026-10-20" {
		t.Fatalf("watermark = %s, want the newest date", plan.Next.DailyThrough)
	}
}

func TestPlanRunDailyEvaluatesAscendingAgainstPrevious(t *testing.T) {
	dates := []Date{"2026-10-16", "2026-10-15", "2026-10-14", "2026-10-13"}
	snap := snapOf(dates, nil, nil)
	plan := PlanRun(State{DailyThrough: "2026-10-13", WeeklyThrough: "2026-10-09"}, snap)
	want := []DailyEval{
		{Date: "2026-10-14", Prev: "2026-10-13"},
		{Date: "2026-10-15", Prev: "2026-10-14"},
		{Date: "2026-10-16", Prev: "2026-10-15"},
	}
	if !reflect.DeepEqual(plan.Daily, want) {
		t.Fatalf("daily = %+v, want %+v", plan.Daily, want)
	}
	if plan.Next.DailyThrough != "2026-10-16" {
		t.Fatalf("watermark = %s", plan.Next.DailyThrough)
	}
}

func TestPlanRunCompletenessGuardHoldsHalfWrittenDate(t *testing.T) {
	dates := []Date{"2026-10-15", "2026-10-14", "2026-10-13"}
	rows := map[Date]map[string]float64{
		"2026-10-13": codesN(10),
		"2026-10-14": codesN(10),
		"2026-10-15": codesN(3), // less than half of the previous day
	}
	snap := snapOf(dates, rows, nil)
	plan := PlanRun(State{DailyThrough: "2026-10-13", WeeklyThrough: "2026-10-09"}, snap)
	if plan.Held != "2026-10-15" {
		t.Fatalf("held = %q, want 2026-10-15", plan.Held)
	}
	if len(plan.Daily) != 1 || plan.Daily[0].Date != "2026-10-14" {
		t.Fatalf("daily before the held date = %+v", plan.Daily)
	}
	if plan.Next.DailyThrough != "2026-10-14" {
		t.Fatalf("watermark must stop before the held date, got %s", plan.Next.DailyThrough)
	}
}

func TestPlanRunBootstrapEvaluatesNothing(t *testing.T) {
	dates := []Date{"2026-10-16", "2026-10-15", "2026-10-14", "2026-10-13"}
	snap := snapOf(dates, nil, nil)
	plan := PlanRun(State{}, snap)
	if !plan.Bootstrap || len(plan.Daily) != 0 || len(plan.Weekly) != 0 {
		t.Fatalf("bootstrap must evaluate nothing: %+v", plan)
	}
	if plan.Next.DailyThrough != "2026-10-16" {
		t.Fatalf("daily watermark = %s, want the latest date", plan.Next.DailyThrough)
	}
	// The week of 12 Oct is complete (its Friday report is present), so it is the
	// bootstrap target for the weekly watermark.
	if plan.Next.WeeklyThrough != "2026-10-16" {
		t.Fatalf("weekly watermark = %s, want 2026-10-16", plan.Next.WeeklyThrough)
	}
}

// codesN builds n distinct codes with readings, for the completeness guard.
func codesN(n int) map[string]float64 {
	out := map[string]float64{}
	for i := 0; i < n; i++ {
		out["C"+pad2(i)] = 1
	}
	return out
}

func pad2(i int) string {
	if i < 10 {
		return "0" + string(rune('0'+i))
	}
	return string(rune('0'+i/10)) + string(rune('0'+i%10))
}

func TestWeeklyNotCompleteUntilFridayOrLaterWeek(t *testing.T) {
	// Week of 12 Oct: Monday to Thursday only. Friday 16 Oct is the last trading
	// day and has no report, and no later week exists, so the week is not complete.
	mondayToThursday := []Date{"2026-10-15", "2026-10-14", "2026-10-13", "2026-10-12", "2026-10-09", "2026-10-08", "2026-10-07", "2026-10-06", "2026-10-05"}
	state := State{DailyThrough: "2026-10-15", WeeklyThrough: "2026-10-09"}
	if plan := PlanRun(state, snapOf(mondayToThursday, nil, nil)); len(plan.Weekly) != 0 {
		t.Fatalf("an incomplete week must not be evaluated: %+v", plan.Weekly)
	}

	withFriday := append([]Date{"2026-10-16"}, mondayToThursday...)
	plan := PlanRun(state, snapOf(withFriday, nil, nil))
	want := []WeekEval{{Date: "2026-10-16", Prev: "2026-10-09"}}
	if !reflect.DeepEqual(plan.Weekly, want) {
		t.Fatalf("weekly = %+v, want %+v (Friday's report, against the previous week's last report)", plan.Weekly, want)
	}
	if plan.Next.WeeklyThrough != "2026-10-16" {
		t.Fatalf("weekly watermark = %s", plan.Next.WeeklyThrough)
	}
}

func TestWeeklyGoodFridayWeekCompleteOnThursday(t *testing.T) {
	// Good Friday 2026 is 3 April, a market holiday. Thursday 2 April is the
	// last trading day of the week, so its report completes the week.
	dates := []Date{"2026-04-02", "2026-04-01", "2026-03-31", "2026-03-30", "2026-03-27", "2026-03-26"}
	state := State{DailyThrough: "2026-04-01", WeeklyThrough: "2026-03-27"}
	plan := PlanRun(state, snapOf(dates, nil, nil))
	want := []WeekEval{{Date: "2026-04-02", Prev: "2026-03-27"}}
	if !reflect.DeepEqual(plan.Weekly, want) {
		t.Fatalf("weekly = %+v, want %+v", plan.Weekly, want)
	}
}

func TestWeeklyCompleteWhenLaterWeekExists(t *testing.T) {
	// Week of 12 Oct has no Friday report, but a report from the week of 19 Oct
	// exists. That makes the earlier week complete (the fallback for data gaps).
	dates := []Date{"2026-10-19", "2026-10-15", "2026-10-14", "2026-10-13", "2026-10-12", "2026-10-09", "2026-10-08"}
	state := State{DailyThrough: "2026-10-15", WeeklyThrough: "2026-10-09"}
	plan := PlanRun(state, snapOf(dates, nil, nil))
	want := []WeekEval{{Date: "2026-10-15", Prev: "2026-10-09"}}
	if !reflect.DeepEqual(plan.Weekly, want) {
		t.Fatalf("weekly = %+v, want %+v", plan.Weekly, want)
	}
}

func TestWeeklyBacklogCapKeepsLatestCompleteWeek(t *testing.T) {
	// Three complete weeks newer than the watermark: only the newest is evaluated.
	dates := []Date{"2026-10-30", "2026-10-23", "2026-10-16", "2026-10-09", "2026-10-02", "2026-09-25"}
	state := State{DailyThrough: "2026-10-30", WeeklyThrough: "2026-09-25"}
	plan := PlanRun(state, snapOf(dates, nil, nil))
	want := []WeekEval{{Date: "2026-10-30", Prev: "2026-10-23"}}
	if !reflect.DeepEqual(plan.Weekly, want) {
		t.Fatalf("weekly = %+v, want %+v", plan.Weekly, want)
	}
	// Candidates after 25 Sep are the weeks ending 2, 9, 16, 23 and 30 October.
	if plan.WeeklySkipped != 4 {
		t.Fatalf("weekly skipped = %d, want 4", plan.WeeklySkipped)
	}
}

func TestWeeklyMonitorEvaluatesOnlyWeeklyPlan(t *testing.T) {
	dates := []Date{d0, d1, d5}
	rows := map[Date]map[string]float64{d0: {"BHP": 6.0}, d1: {"BHP": 4.0}, d5: {"BHP": 4.0}}
	snap := snapOf(dates, rows, nil)
	daily := mon(alertevents.ScopeStock, "BHP", alertevents.ConditionShortInterestAbove, alertevents.CadenceDaily, fp(5))
	weekly := mon(alertevents.ScopeStock, "BHP", alertevents.ConditionShortInterestAbove, alertevents.CadenceWeekly, fp(5))
	plan := Plan{Weekly: []WeekEval{{Date: d0, Prev: d5}}}
	got := Evaluate([]Monitor{daily, weekly}, snap, plan)
	if len(got) != 1 || got[0].Monitor.Cadence != alertevents.CadenceWeekly {
		t.Fatalf("only the weekly monitor belongs to a weekly plan: %+v", got)
	}
	if got[0].ReportDate != d0 || got[0].ComparedTo != d5 {
		t.Fatalf("weekly dates = %s vs %s", got[0].ReportDate, got[0].ComparedTo)
	}
}

func TestPlanReplayNeverMovesWatermarks(t *testing.T) {
	dates := []Date{d0, d1, d2}
	snap := snapOf(dates, nil, nil)
	plan, err := PlanReplay(snap, d1)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(plan.Daily, []DailyEval{{Date: d1, Prev: d2}}) {
		t.Fatalf("replay plan = %+v", plan.Daily)
	}
	if plan.Next != (State{}) || plan.Bootstrap || len(plan.Weekly) != 0 {
		t.Fatalf("a replay plan must carry no watermark change: %+v", plan)
	}
	if _, err := PlanReplay(snap, "2026-01-01"); err == nil {
		t.Fatal("a date outside the window must be refused")
	}
	if _, err := PlanReplay(snap, d2); err == nil {
		t.Fatal("the oldest date has no previous report and must be refused")
	}
}

func TestPayloadStoresFiftyButCountsAll(t *testing.T) {
	dates := []Date{d0, d1}
	rows := map[Date]map[string]float64{d0: {}, d1: {}}
	meta := map[string]CompanyInfo{}
	for i := 0; i < 60; i++ {
		code := "X" + pad2(i)
		meta[code] = CompanyInfo{Name: code, Industry: "Materials"}
		rows[d0][code] = 6.0
		rows[d1][code] = 1.0
	}
	snap := snapOf(dates, rows, meta)
	m := mon(alertevents.ScopeIndustry, "Materials", alertevents.ConditionShortInterestAbove, alertevents.CadenceDaily, fp(5))
	got := Evaluate([]Monitor{m}, snap, dailyPlan(d0, d1))
	if got[0].Payload.CompaniesTotal != 60 || len(got[0].Payload.Companies) != storedCompanies {
		t.Fatalf("total=%d stored=%d", got[0].Payload.CompaniesTotal, len(got[0].Payload.Companies))
	}
}

func TestMondayOfAndLastTradingDay(t *testing.T) {
	// 16 October 2026 is a Friday, and its ISO week starts on Monday 12 October.
	d, err := Date("2026-10-16").Day()
	if err != nil {
		t.Fatal(err)
	}
	if got := mondayOf(d).Format(dateLayout); got != "2026-10-12" {
		t.Fatalf("mondayOf(16 Oct 2026) = %s, want 2026-10-12", got)
	}
	if got := lastTradingDay(mondayOf(d)); got != "2026-10-16" {
		t.Fatalf("last trading day = %s, want Friday 16 Oct", got)
	}
	// Good Friday 2026: the week's last trading day is Thursday.
	g, _ := Date("2026-04-03").Day()
	if got := lastTradingDay(mondayOf(g)); got != "2026-04-02" {
		t.Fatalf("Good Friday week last trading day = %s, want 2026-04-02", got)
	}
}
