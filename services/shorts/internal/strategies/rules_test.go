package strategies

import (
	"math"
	"strings"
	"testing"
	"time"
)

func f(v float64) *float64 { return &v }
func i32(v int32) *int32   { return &v }
func b(v bool) *bool       { return &v }
func d(s string) *time.Time {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		panic(err)
	}
	return &t
}

type ruleCase struct {
	name       string
	cand       Candidate
	env        evalEnv
	want       RuleStatus
	wantValue  *float64 // nil: HasValue must be false
	wantDetail []string // fragments the detail must contain
}

func runRuleCases(t *testing.T, fn ruleFunc, cases []ruleCase) {
	t.Helper()
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			env := tc.env
			out := fn(&tc.cand, &env)
			if out.Status != tc.want {
				t.Fatalf("status = %q, want %q (detail %q)", out.Status, tc.want, out.Detail)
			}
			if tc.wantValue == nil {
				if out.HasValue {
					t.Errorf("HasValue = true (value %v), want false", out.Value)
				}
			} else {
				if !out.HasValue {
					t.Errorf("HasValue = false, want value %v", *tc.wantValue)
				} else if math.Abs(out.Value-*tc.wantValue) > 1e-6 {
					t.Errorf("value = %v, want %v", out.Value, *tc.wantValue)
				}
			}
			if strings.TrimSpace(out.Detail) == "" {
				t.Error("detail is empty; every outcome must explain itself")
			}
			for _, frag := range tc.wantDetail {
				if !strings.Contains(out.Detail, frag) {
					t.Errorf("detail %q does not contain %q", out.Detail, frag)
				}
			}
			if strings.ContainsRune(out.Detail, '—') {
				t.Errorf("em dash in detail %q", out.Detail)
			}
			if out.Strength < 0 || out.Strength > 1 {
				t.Errorf("strength %v outside 0..1", out.Strength)
			}
		})
	}
}

func withGrowth(g Growth) Candidate { return Candidate{StockCode: "TST", Close: 10, Growth: &g} }

func TestRuleGrowth(t *testing.T) {
	runRuleCases(t, ruleGrowth, []ruleCase{
		{name: "no growth row is unknown", cand: Candidate{StockCode: "TST"}, want: RuleUnknown, wantDetail: []string{"No reported fundamentals"}},
		{name: "both yoy null is unknown", cand: withGrowth(Growth{}), want: RuleUnknown, wantDetail: []string{"No revenue or EPS growth"}},
		{name: "revenue at threshold passes", cand: withGrowth(Growth{RevenueYoYPct: f(25), LatestAnnualPeriodEnd: d("2026-06-30")}),
			want: RulePass, wantValue: f(25), wantDetail: []string{"Revenue +25.0% YoY (FY ending 2026-06-30)"}},
		{name: "eps alone passes", cand: withGrowth(Growth{RevenueYoYPct: f(3), EPSYoYPct: f(41), BasisPeriodType: "ttm", LatestPeriodEnd: d("2026-06-30")}),
			want: RulePass, wantValue: f(41), wantDetail: []string{"EPS +41.0% YoY (12 months to 2026-06-30)", "Revenue +3.0%"}},
		{name: "revenue just under and eps null fails", cand: withGrowth(Growth{RevenueYoYPct: f(24.9)}),
			want: RuleFail, wantValue: f(24.9), wantDetail: []string{"below the +25% threshold"}},
		{name: "both under fails", cand: withGrowth(Growth{RevenueYoYPct: f(10), EPSYoYPct: f(-5)}), want: RuleFail, wantValue: f(10)},
		{name: "prior loss now profit passes with no yoy", cand: withGrowth(Growth{NetIncomePrior: f(-2e6), NetIncomePositive: b(true)}),
			want: RulePass, wantDetail: []string{"Swung from a net loss to a net profit"}},
		{name: "prior exactly zero now profit passes", cand: withGrowth(Growth{NetIncomePrior: f(0), NetIncomePositive: b(true), RevenueYoYPct: f(5)}),
			want: RulePass, wantValue: f(5)},
		{name: "prior loss still loss is not a turnaround", cand: withGrowth(Growth{NetIncomePrior: f(-2e6), NetIncomePositive: b(false), RevenueYoYPct: f(5)}),
			want: RuleFail, wantValue: f(5)},
		{name: "profit flag without a prior is not a turnaround", cand: withGrowth(Growth{NetIncomePositive: b(true)}), want: RuleUnknown},
		{name: "positive half delta is evidence only, not a pass", cand: withGrowth(Growth{RevenueYoYPct: f(10), RevenueHalfDelta: f(1e6)}),
			want: RuleFail, wantValue: f(10), wantDetail: []string{"latest half-year revenue up on the same half a year earlier"}},
		{name: "half delta shown on a pass", cand: withGrowth(Growth{RevenueYoYPct: f(30), RevenueHalfDelta: f(5), NetIncomeHalfDelta: f(2)}),
			want: RulePass, wantValue: f(30), wantDetail: []string{"half-year revenue up", "half-year profit up"}},
		{name: "negative half delta is not mentioned", cand: withGrowth(Growth{RevenueYoYPct: f(30), RevenueHalfDelta: f(-5)}), want: RulePass, wantValue: f(30)},
		{name: "acceleration is described", cand: withGrowth(Growth{RevenueYoYPct: f(40), RevenueYoYPriorPct: f(20)}),
			want: RulePass, wantValue: f(40), wantDetail: []string{"accelerating from +20.0%"}},
		{name: "half revenue basis is labelled as half on half",
			cand: withGrowth(Growth{RevenueBasisPeriodType: "half", RevenueYoYPct: f(31), HalfLatestPeriodEnd: d("2026-12-31"), LatestAnnualPeriodEnd: d("2026-06-30")}),
			want: RulePass, wantValue: f(31), wantDetail: []string{"Revenue +31.0% YoY (half-year to 2026-12-31 vs same half a year earlier)"}},
		{name: "half eps basis is labelled as half on half",
			cand: withGrowth(Growth{BasisPeriodType: "half", EPSYoYPct: f(40), LatestPeriodEnd: d("2026-12-31"), HalfLatestPeriodEnd: d("2026-12-31")}),
			want: RulePass, wantValue: f(40), wantDetail: []string{"EPS +40.0% YoY (half-year to 2026-12-31 vs same half a year earlier)"}},
		{name: "annual revenue basis keeps the FY label", cand: withGrowth(Growth{RevenueBasisPeriodType: "annual", RevenueYoYPct: f(26), LatestAnnualPeriodEnd: d("2026-06-30"), HalfLatestPeriodEnd: d("2025-12-31")}),
			want: RulePass, wantValue: f(26), wantDetail: []string{"Revenue +26.0% YoY (FY ending 2026-06-30)"}},

		// Plan fundamentals-coverage.md §5.4: the TTM revenue basis.
		{name: "ttm revenue basis is labelled with its period end",
			cand: withGrowth(Growth{RevenueBasisPeriodType: "ttm", RevenueYoYPct: f(30), RevenueLatestPeriodEnd: d("2026-12-31"), LatestAnnualPeriodEnd: d("2026-06-30")}),
			want: RulePass, wantValue: f(30), wantDetail: []string{"Revenue +30.0% YoY (12 months to 2026-12-31)"}},
		{name: "ttm revenue basis without an end date", cand: withGrowth(Growth{RevenueBasisPeriodType: "ttm", RevenueYoYPct: f(30)}),
			want: RulePass, wantValue: f(30), wantDetail: []string{"(trailing 12 months)"}},

		// Loss-making and turnarounds are judged on the EPS basis.
		{name: "still loss-making on the eps basis fails, not unknown",
			cand: withGrowth(Growth{BasisPeriodType: "ttm", LatestPeriodEnd: d("2026-06-30"), EPSLatest: f(-0.05), EPSPrior: f(-0.10)}),
			want: RuleFail, wantDetail: []string{"Still loss-making on EPS (12 months to 2026-06-30)"}},
		{name: "an older annual profit does not overrule a fresher ttm loss",
			cand: withGrowth(Growth{BasisPeriodType: "ttm", LatestPeriodEnd: d("2026-12-31"), LatestAnnualPeriodEnd: d("2026-06-30"),
				EPSLatest: f(-0.02), EPSPrior: f(0.01), EPSYoYPct: f(-300), NetIncomePrior: f(-1), NetIncomePositive: b(true)}),
			want: RuleFail, wantValue: f(-300), wantDetail: []string{"still loss-making on EPS", "below the +25% threshold"}},
		{name: "an annual turnaround counts when the annual is as new as the eps basis",
			cand: withGrowth(Growth{BasisPeriodType: "ttm", LatestPeriodEnd: d("2026-06-30"), LatestAnnualPeriodEnd: d("2026-06-30"),
				NetIncomePrior: f(-1), NetIncomePositive: b(true)}),
			want: RulePass, wantDetail: []string{"Swung from a net loss to a net profit"}},
		{name: "an eps turnaround on the ttm basis passes",
			cand: withGrowth(Growth{BasisPeriodType: "ttm", LatestPeriodEnd: d("2026-06-30"), EPSLatest: f(0.12), EPSPrior: f(-0.04)}),
			want: RulePass, wantDetail: []string{"EPS swung from a loss to a profit (12 months to 2026-06-30)"}},
	})

	// A ttm revenue basis already is the fresher figure the half delta would
	// hint at, so the delta is not restated as evidence.
	ttm := ruleGrowth(&Candidate{Growth: &Growth{RevenueBasisPeriodType: "ttm", RevenueYoYPct: f(30), RevenueHalfDelta: f(5), NetIncomeHalfDelta: f(2)}}, &evalEnv{})
	if strings.Contains(ttm.Detail, "latest half-year revenue up") || !strings.Contains(ttm.Detail, "latest half-year profit up") {
		t.Errorf("ttm revenue basis must skip only the revenue evidence line: %q", ttm.Detail)
	}
	// Acceleration needs a positive prior: -40% to +30% is a recovery, not
	// acceleration.
	rec := ruleGrowth(&Candidate{Growth: &Growth{RevenueYoYPct: f(30), RevenueYoYPriorPct: f(-40)}}, &evalEnv{})
	if strings.Contains(rec.Detail, "accelerating") {
		t.Errorf("growth from a negative prior must not read as accelerating: %q", rec.Detail)
	}
	zero := ruleGrowth(&Candidate{Growth: &Growth{RevenueYoYPct: f(30), RevenueYoYPriorPct: f(0)}}, &evalEnv{})
	if strings.Contains(zero.Detail, "accelerating") {
		t.Errorf("growth from a zero prior must not read as accelerating: %q", zero.Detail)
	}

	// On the half revenue basis the half delta is the headline, not evidence.
	half := ruleGrowth(&Candidate{Growth: &Growth{RevenueBasisPeriodType: "half", RevenueYoYPct: f(30), RevenueHalfDelta: f(5)}}, &evalEnv{})
	if strings.Contains(half.Detail, "latest half-year revenue up") {
		t.Errorf("half revenue basis must not restate the half delta as evidence: %q", half.Detail)
	}
	if strings.Contains(half.Detail, "FY ending") || strings.Contains(half.Detail, "(annual)") {
		t.Errorf("half revenue basis must not be labelled annual: %q", half.Detail)
	}

	out := ruleGrowth(&Candidate{Growth: &Growth{RevenueYoYPct: f(30), RevenueHalfDelta: f(-5)}}, &evalEnv{})
	if strings.Contains(out.Detail, "half-year") {
		t.Errorf("a negative half delta must not be claimed as evidence: %q", out.Detail)
	}
}

func TestRuleEPSGrowth(t *testing.T) {
	runRuleCases(t, ruleEPSGrowth, []ruleCase{
		{name: "no row", cand: Candidate{}, want: RuleUnknown},
		{name: "null eps", cand: withGrowth(Growth{RevenueYoYPct: f(90)}), want: RuleUnknown, wantDetail: []string{"No EPS growth"}},
		{name: "at threshold", cand: withGrowth(Growth{EPSYoYPct: f(25), BasisPeriodType: "annual", LatestAnnualPeriodEnd: d("2025-06-30")}),
			want: RulePass, wantValue: f(25), wantDetail: []string{"FY ending 2025-06-30"}},
		{name: "under", cand: withGrowth(Growth{EPSYoYPct: f(24.99)}), want: RuleFail, wantValue: f(24.99)},
		{name: "turnaround passes", cand: withGrowth(Growth{NetIncomePrior: f(-1), NetIncomePositive: b(true)}), want: RulePass},
		{name: "half basis without a half end date falls back to latest_period_end",
			cand: withGrowth(Growth{EPSYoYPct: f(30), BasisPeriodType: "half", LatestPeriodEnd: d("2026-12-31")}),
			want: RulePass, wantValue: f(30), wantDetail: []string{"half-year to 2026-12-31 vs same half a year earlier"}},
		{name: "half basis with no dates is still labelled half", cand: withGrowth(Growth{EPSYoYPct: f(10), BasisPeriodType: "half"}),
			want: RuleFail, wantValue: f(10), wantDetail: []string{"(half-year vs same half a year earlier)"}},
		{name: "turnaround with a weak eps figure still passes", cand: withGrowth(Growth{EPSYoYPct: f(3), NetIncomePrior: f(-1), NetIncomePositive: b(true)}),
			want: RulePass, wantValue: f(3)},

		// Plan fundamentals-coverage.md §5.4: same-basis loss and turnaround.
		{name: "still loss-making on the half basis fails, not unknown",
			cand: withGrowth(Growth{BasisPeriodType: "half", HalfLatestPeriodEnd: d("2026-12-31"), EPSLatest: f(-0.03), EPSPrior: f(-0.05)}),
			want: RuleFail, wantDetail: []string{"Still loss-making on EPS (half-year to 2026-12-31 vs same half a year earlier)"}},
		{name: "a swing into loss fails with its growth figure",
			cand: withGrowth(Growth{BasisPeriodType: "annual", LatestAnnualPeriodEnd: d("2026-06-30"), EPSLatest: f(-0.1), EPSPrior: f(0.2), EPSYoYPct: f(-150)}),
			want: RuleFail, wantValue: f(-150), wantDetail: []string{"EPS -150.0% YoY", "still loss-making"}},
		{name: "a half-basis eps turnaround passes",
			cand: withGrowth(Growth{BasisPeriodType: "half", HalfLatestPeriodEnd: d("2026-12-31"), EPSLatest: f(0.04), EPSPrior: f(-0.01)}),
			want: RulePass, wantDetail: []string{"EPS swung from a loss to a profit (half-year to 2026-12-31"}},
		{name: "an older annual turnaround does not speak for a fresher half",
			cand: withGrowth(Growth{BasisPeriodType: "half", LatestPeriodEnd: d("2026-12-31"), HalfLatestPeriodEnd: d("2026-12-31"), LatestAnnualPeriodEnd: d("2026-06-30"),
				EPSLatest: f(0.02), EPSPrior: f(0.05), EPSYoYPct: f(-60), NetIncomePrior: f(-1), NetIncomePositive: b(true)}),
			want: RuleFail, wantValue: f(-60), wantDetail: []string{"below the +25% threshold"}},
		{name: "eps at exactly zero is still loss-making",
			cand: withGrowth(Growth{BasisPeriodType: "ttm", EPSLatest: f(0), EPSPrior: f(-0.01)}),
			want: RuleFail, wantDetail: []string{"Still loss-making on EPS (trailing 12 months)"}},
	})
}

func TestEPSTurnaroundAndLossMaking(t *testing.T) {
	cases := []struct {
		name       string
		g          *Growth
		turn, loss bool
	}{
		{"nil", nil, false, false},
		{"no eps, no annual swing", &Growth{}, false, false},
		{"eps swing on the basis", &Growth{BasisPeriodType: "ttm", EPSLatest: f(1), EPSPrior: f(-1)}, true, false},
		{"eps swing from exactly zero", &Growth{EPSLatest: f(1), EPSPrior: f(0)}, true, false},
		{"annual swing, annual basis", &Growth{BasisPeriodType: "annual", NetIncomePrior: f(-1), NetIncomePositive: b(true)}, true, false},
		{"annual swing, empty basis reads annual", &Growth{NetIncomePrior: f(-1), NetIncomePositive: b(true)}, true, false},
		{"annual swing older than the ttm basis", &Growth{BasisPeriodType: "ttm", LatestPeriodEnd: d("2026-12-31"), LatestAnnualPeriodEnd: d("2026-06-30"), NetIncomePrior: f(-1), NetIncomePositive: b(true)}, false, false},
		{"annual swing as new as the ttm basis", &Growth{BasisPeriodType: "ttm", LatestPeriodEnd: d("2026-06-30"), LatestAnnualPeriodEnd: d("2026-06-30"), NetIncomePrior: f(-1), NetIncomePositive: b(true)}, true, false},
		{"annual swing, half basis, no dates", &Growth{BasisPeriodType: "half", NetIncomePrior: f(-1), NetIncomePositive: b(true)}, false, false},
		{"loss on the basis", &Growth{BasisPeriodType: "ttm", EPSLatest: f(-1), EPSPrior: f(-2)}, false, true},
		{"loss on the basis overrides an older annual swing", &Growth{BasisPeriodType: "ttm", LatestPeriodEnd: d("2026-12-31"), LatestAnnualPeriodEnd: d("2026-06-30"), EPSLatest: f(-1), NetIncomePrior: f(-1), NetIncomePositive: b(true)}, false, true},
		{"profit on the basis is not a loss", &Growth{EPSLatest: f(0.5), EPSPrior: f(0.4)}, false, false},
	}
	for _, tc := range cases {
		if got := tc.g.EPSTurnaround(); got != tc.turn {
			t.Errorf("%s: EPSTurnaround = %v, want %v", tc.name, got, tc.turn)
		}
		if got := tc.g.EPSLossMaking(); got != tc.loss {
			t.Errorf("%s: EPSLossMaking = %v, want %v", tc.name, got, tc.loss)
		}
	}
}

func withQuality(q Quality) Candidate { return Candidate{StockCode: "TST", Close: 10, Quality: &q} }

func TestRuleROE(t *testing.T) {
	runRuleCases(t, ruleROE, []ruleCase{
		{name: "no quality row", cand: Candidate{}, want: RuleUnknown, wantDetail: []string{"No reported financial statements"}},
		{name: "at 15 passes", cand: withQuality(Quality{ROEPct: f(15), TotalEquity: f(1), BasisPeriodType: "annual", BasisPeriodEnd: d("2026-06-30")}),
			want: RulePass, wantValue: f(15), wantDetail: []string{"Return on equity 15.0% (FY ending 2026-06-30)"}},
		{name: "ttm basis label", cand: withQuality(Quality{ROEPct: f(22), BasisPeriodType: "ttm", BasisPeriodEnd: d("2026-12-31")}),
			want: RulePass, wantValue: f(22), wantDetail: []string{"(12 months to 2026-12-31)"}},
		{name: "under 15 fails", cand: withQuality(Quality{ROEPct: f(14.9), TotalEquity: f(1)}), want: RuleFail, wantValue: f(14.9), wantDetail: []string{"below the 15% threshold"}},
		{name: "negative roe fails", cand: withQuality(Quality{ROEPct: f(-8), TotalEquity: f(1)}), want: RuleFail, wantValue: f(-8)},
		{name: "negative equity fails even without a ratio", cand: withQuality(Quality{TotalEquity: f(-5e6)}), want: RuleFail, wantDetail: []string{"zero or negative"}},
		{name: "zero equity fails", cand: withQuality(Quality{TotalEquity: f(0), ROEPct: f(40)}), want: RuleFail},
		{name: "null roe for another reason is unknown", cand: withQuality(Quality{TotalEquity: f(1e9)}), want: RuleUnknown, wantDetail: []string{"10% of total assets"}},
	})
}

func TestRuleNetMargin(t *testing.T) {
	runRuleCases(t, ruleNetMargin, []ruleCase{
		{name: "no quality row", cand: Candidate{}, want: RuleUnknown},
		{name: "no revenue", cand: withQuality(Quality{NetMarginPct: f(12)}), want: RuleUnknown, wantDetail: []string{"revenue"}},
		{name: "zero revenue", cand: withQuality(Quality{Revenue: f(0), NetMarginPct: f(12)}), want: RuleUnknown},
		{name: "negative revenue", cand: withQuality(Quality{Revenue: f(-1), NetMarginPct: f(12)}), want: RuleUnknown},
		{name: "no net profit", cand: withQuality(Quality{Revenue: f(1e9)}), want: RuleUnknown, wantDetail: []string{"net profit"}},
		{name: "at 10 passes", cand: withQuality(Quality{Revenue: f(1e9), NetMarginPct: f(10)}), want: RulePass, wantValue: f(10), wantDetail: []string{"Net margin 10.0%"}},
		{name: "under 10 fails", cand: withQuality(Quality{Revenue: f(1e9), NetMarginPct: f(9.99)}), want: RuleFail, wantValue: f(9.99), wantDetail: []string{"below the 10% threshold"}},
		{name: "a loss fails", cand: withQuality(Quality{Revenue: f(1e9), NetMarginPct: f(-4)}), want: RuleFail, wantValue: f(-4)},
	})
}

func TestRuleCashConversion(t *testing.T) {
	runRuleCases(t, ruleCashConversion, []ruleCase{
		{name: "no quality row", cand: Candidate{}, want: RuleUnknown},
		{name: "financial is not meaningful", cand: withQuality(Quality{IsFinancial: true, FreeCashFlow: f(9), NetIncome: f(10)}),
			want: RuleUnknown, wantDetail: []string{"Not meaningful for banks, insurers and other financials"}},
		{name: "not-meaningful list alone", cand: withQuality(Quality{NotMeaningful: []string{RatioFCFConversion}, FreeCashFlow: f(9), NetIncome: f(10)}), want: RuleUnknown},
		{name: "no fcf", cand: withQuality(Quality{NetIncome: f(10)}), want: RuleUnknown},
		{name: "no net income", cand: withQuality(Quality{FreeCashFlow: f(10)}), want: RuleUnknown},
		{name: "loss fails", cand: withQuality(Quality{FreeCashFlow: f(10), NetIncome: f(-1)}), want: RuleFail, wantDetail: []string{"zero or negative"}},
		{name: "zero profit fails", cand: withQuality(Quality{FreeCashFlow: f(10), NetIncome: f(0)}), want: RuleFail},
		{name: "negative fcf fails", cand: withQuality(Quality{FreeCashFlow: f(-5), NetIncome: f(10)}), want: RuleFail, wantValue: f(-0.5), wantDetail: []string{"Free cash flow is zero or negative"}},
		{name: "at 0.8x passes", cand: withQuality(Quality{FreeCashFlow: f(8), NetIncome: f(10)}), want: RulePass, wantValue: f(0.8), wantDetail: []string{"0.80x net profit"}},
		{name: "under 0.8x fails", cand: withQuality(Quality{FreeCashFlow: f(7.9), NetIncome: f(10)}), want: RuleFail, wantValue: f(0.79), wantDetail: []string{"under 0.8x"}},
	})
}

func TestRuleLeverage(t *testing.T) {
	runRuleCases(t, ruleLeverage, []ruleCase{
		{name: "no quality row", cand: Candidate{}, want: RuleUnknown},
		{name: "financial is not meaningful", cand: withQuality(Quality{IsFinancial: true, NetDebt: f(1), EBITDA: f(10)}), want: RuleUnknown, wantDetail: []string{"Not meaningful"}},
		{name: "no net debt", cand: withQuality(Quality{EBITDA: f(10)}), want: RuleUnknown, wantDetail: []string{"Net debt cannot be measured"}},
		{name: "net cash passes", cand: withQuality(Quality{NetDebt: f(-318e6), EBITDA: f(636e6), Currency: "USD"}),
			want: RulePass, wantValue: f(-0.5), wantDetail: []string{"Net cash of USD 318.0m, excluding leases"}},
		{name: "net cash passes without ebitda", cand: withQuality(Quality{NetDebt: f(-5e6), Currency: "AUD"}), want: RulePass, wantDetail: []string{"Net cash of A$5.0m"}},
		{name: "zero net debt passes", cand: withQuality(Quality{NetDebt: f(0), EBITDA: f(10)}), want: RulePass, wantValue: f(0), wantDetail: []string{"No net debt"}},
		{name: "normalised ebitda is preferred", cand: withQuality(Quality{NetDebt: f(25), NormalizedEBITDA: f(10), EBITDA: f(5)}), want: RulePass, wantValue: f(2.5)},
		{name: "statutory ebitda when no normalised", cand: withQuality(Quality{NetDebt: f(26), EBITDA: f(10)}), want: RuleFail, wantValue: f(2.6), wantDetail: []string{"above 2.5x"}},
		{name: "net debt with no ebitda is unknown", cand: withQuality(Quality{NetDebt: f(5e6)}), want: RuleUnknown, wantDetail: []string{"no EBITDA"}},
		{name: "net debt with negative ebitda fails", cand: withQuality(Quality{NetDebt: f(5e6), EBITDA: f(-1)}), want: RuleFail, wantDetail: []string{"zero or negative EBITDA"}},
	})
}

func TestRuleAboveSMA200(t *testing.T) {
	runRuleCases(t, ruleAboveSMA200, []ruleCase{
		{name: "null", cand: Candidate{Close: 10}, want: RuleUnknown},
		{name: "zero average", cand: Candidate{Close: 10, SMA200: f(0)}, want: RuleUnknown},
		{name: "above", cand: Candidate{Close: 11, SMA200: f(10)}, want: RulePass, wantValue: f(10), wantDetail: []string{"200-day average A$10.00"}},
		{name: "equal fails", cand: Candidate{Close: 10, SMA200: f(10)}, want: RuleFail, wantValue: f(0), wantDetail: []string{"not above"}},
		{name: "below", cand: Candidate{Close: 9, SMA200: f(10)}, want: RuleFail, wantValue: f(-10)},
	})
}

func TestRuleRevenueNotShrinking(t *testing.T) {
	runRuleCases(t, ruleRevenueNotShrinking, []ruleCase{
		{name: "no row", cand: Candidate{}, want: RuleUnknown},
		{name: "no revenue growth", cand: withGrowth(Growth{EPSYoYPct: f(5)}), want: RuleUnknown},
		{name: "flat passes", cand: withGrowth(Growth{RevenueYoYPct: f(0)}), want: RulePass, wantValue: f(0)},
		{name: "growth passes", cand: withGrowth(Growth{RevenueYoYPct: f(7), LatestAnnualPeriodEnd: d("2026-06-30")}), want: RulePass, wantValue: f(7), wantDetail: []string{"FY ending 2026-06-30"}},
		{name: "shrinking fails", cand: withGrowth(Growth{RevenueYoYPct: f(-0.1)}), want: RuleFail, wantValue: f(-0.1), wantDetail: []string{"revenue shrank"}},
	})
}

func TestRuleRevenueGrowth(t *testing.T) {
	runRuleCases(t, ruleRevenueGrowth, []ruleCase{
		{name: "no row", cand: Candidate{}, want: RuleUnknown},
		{name: "null revenue", cand: withGrowth(Growth{EPSYoYPct: f(50)}), want: RuleUnknown},
		{name: "at 20", cand: withGrowth(Growth{RevenueYoYPct: f(20)}), want: RulePass, wantValue: f(20)},
		{name: "under 20", cand: withGrowth(Growth{RevenueYoYPct: f(19.9)}), want: RuleFail, wantValue: f(19.9), wantDetail: []string{"+20%"}},
		{name: "half basis at 20 passes with the half label",
			cand: withGrowth(Growth{RevenueBasisPeriodType: "half", RevenueYoYPct: f(20), HalfLatestPeriodEnd: d("2026-12-31")}),
			want: RulePass, wantValue: f(20), wantDetail: []string{"half-year to 2026-12-31 vs same half a year earlier"}},
	})
}

func TestRuleBase(t *testing.T) {
	base := func(depth float64, length int32, close, low float64) Candidate {
		return Candidate{Close: close, BaseDepthPct: f(depth), BaseLengthDays: i32(length), BaseLow: f(low), BaseHigh: f(low / (1 - depth/100))}
	}
	runRuleCases(t, ruleBase, []ruleCase{
		{name: "missing depth", cand: Candidate{BaseLengthDays: i32(30), BaseLow: f(1)}, want: RuleUnknown},
		{name: "missing length", cand: Candidate{BaseDepthPct: f(10), BaseLow: f(1)}, want: RuleUnknown},
		{name: "missing low", cand: Candidate{BaseDepthPct: f(10), BaseLengthDays: i32(30)}, want: RuleUnknown},
		{name: "tight base passes", cand: base(12, 30, 9.5, 8.8), want: RulePass, wantValue: f(12),
			wantDetail: []string{"30-session base", "12.0% deep", "A$9.50", "A$8.80"}},
		{name: "length 20 passes", cand: base(10, 20, 9, 8), want: RulePass, wantValue: f(10)},
		{name: "length 40 (window ceiling) passes", cand: base(10, 40, 9, 8), want: RulePass, wantValue: f(10)},
		{name: "length 19 fails", cand: base(10, 19, 9, 8), want: RuleFail, wantValue: f(10), wantDetail: []string{"only 19 sessions", "under 20"}},
		{name: "depth 25 passes", cand: base(25, 30, 9, 8), want: RulePass, wantValue: f(25)},
		{name: "depth 25.1 fails", cand: base(25.1, 30, 9, 8), want: RuleFail, wantValue: f(25.1), wantDetail: []string{"deeper than 25%"}},
		{name: "close at the low passes", cand: base(10, 30, 8, 8), want: RulePass, wantValue: f(10)},
		{name: "close under the low fails", cand: base(10, 30, 7.99, 8), want: RuleFail, wantValue: f(10), wantDetail: []string{"below the base low"}},
		{name: "several reasons listed", cand: base(40, 5, 7, 8), want: RuleFail, wantValue: f(40), wantDetail: []string{"only 5", "deeper", "below the base low"}},
	})

	// mv_price_features anchors the base at the breakout session, so after a
	// breakout the length still describes the base that was cleared and a
	// genuinely short base is not excused by the breakout flag.
	through := func(depth float64, length int32, close, low float64, breakout bool) Candidate {
		c := base(depth, length, close, low)
		c.BreakoutRecent = b(breakout)
		return c
	}
	runRuleCases(t, ruleBase, []ruleCase{
		{name: "a 30-session base cleared by a recent breakout passes", cand: through(12.6, 30, 10.2, 9, true), want: RulePass, wantValue: f(12.6),
			wantDetail: []string{"30-session base", "12.6% deep"}},
		{name: "a short base is not excused by a breakout", cand: through(12.6, 5, 10.2, 9, true), want: RuleFail, wantValue: f(12.6), wantDetail: []string{"only 5 sessions"}},
		{name: "a short base without a breakout fails", cand: through(12.6, 1, 10.2, 9, false), want: RuleFail, wantValue: f(12.6)},
		{name: "a deep base cleared by a breakout fails", cand: through(30, 30, 10.2, 7, true), want: RuleFail, wantValue: f(30), wantDetail: []string{"deeper than 25%"}},
		{name: "a close back under the base low fails", cand: through(12, 30, 8.9, 9, true), want: RuleFail, wantValue: f(12), wantDetail: []string{"below the base low"}},
	})
}

func TestRuleBreakout(t *testing.T) {
	asOf := *d("2026-09-25")
	runRuleCases(t, ruleBreakout, []ruleCase{
		{name: "null breakout flag is unknown", cand: Candidate{Close: 10, BaseHigh: f(9)}, want: RuleUnknown},
		{name: "breakout passes with date and pivot", cand: Candidate{AsOf: asOf, Close: 10, BaseHigh: f(9.5), BreakoutRecent: b(true), BreakoutDate: d("2026-09-24")},
			want: RulePass, wantValue: f((10/9.5 - 1) * 100), wantDetail: []string{"Broke out on 2026-09-24", "1.5x average volume", "pivot A$9.50"}},
		{name: "breakout without a date", cand: Candidate{Close: 10, BreakoutRecent: b(true)}, want: RulePass, wantDetail: []string{"last 5 sessions"}},
		{name: "a one-session base still names the anchored pivot", cand: Candidate{AsOf: asOf, Close: 10.2, BaseHigh: f(9.8), BaseLengthDays: i32(1), BreakoutRecent: b(true), BreakoutDate: d("2026-09-24")},
			want: RulePass, wantValue: f((10.2/9.8 - 1) * 100), wantDetail: []string{"Broke out on 2026-09-24", "pivot A$9.80"}},
		{name: "no breakout fails with distance to pivot", cand: Candidate{Close: 9, BaseHigh: f(10), BreakoutRecent: b(false)},
			want: RuleFail, wantValue: f(-10), wantDetail: []string{"A$10.00 pivot", "-10.0% from the pivot"}},
		{name: "no breakout and no pivot", cand: Candidate{Close: 9, BreakoutRecent: b(false)}, want: RuleFail},
		{name: "zero pivot yields no value", cand: Candidate{Close: 9, BaseHigh: f(0), BreakoutRecent: b(false)}, want: RuleFail},
	})
	if out := ruleBreakout(&Candidate{Close: 10, BaseHigh: f(9.5), BaseLengthDays: i32(30), BreakoutRecent: b(true)}, &evalEnv{}); !strings.Contains(out.Detail, "pivot A$9.50") {
		t.Errorf("a pre-breakout base high is the pivot: %q", out.Detail)
	}
	fresh := ruleBreakout(&Candidate{AsOf: asOf, Close: 10, BreakoutRecent: b(true), BreakoutDate: d("2026-09-25")}, &evalEnv{})
	stale := ruleBreakout(&Candidate{AsOf: asOf, Close: 10, BreakoutRecent: b(true), BreakoutDate: d("2026-09-19")}, &evalEnv{})
	if !(fresh.Strength > stale.Strength) {
		t.Errorf("a fresher breakout must grade stronger: fresh %v, stale %v", fresh.Strength, stale.Strength)
	}
}

func TestRuleRegime(t *testing.T) {
	up := evalEnv{regime: Regime{IndexCode: "XJO", Label: RegimeUptrend, Close: f(8800), SMA200: f(8000)}}
	neutral := evalEnv{regime: Regime{Label: RegimeNeutral}}
	down := evalEnv{regime: Regime{IndexCode: "XJO", Label: RegimeDowntrend, Close: f(7600), SMA200: f(8000)}}
	runRuleCases(t, ruleRegime, []ruleCase{
		{name: "no regime row is unknown", env: evalEnv{}, want: RuleUnknown, wantDetail: []string{"S&P/ASX 200"}},
		{name: "a NULL regime (under 200 index sessions) is unknown", env: evalEnv{regime: Regime{IndexCode: "XJO", Close: f(8000), Label: ""}}, want: RuleUnknown, wantDetail: []string{"Not enough recent"}},
		{name: "unrecognised label is unknown", env: evalEnv{regime: Regime{Label: "sideways"}}, want: RuleUnknown},
		{name: "uptrend passes", env: up, want: RulePass, wantValue: f(10), wantDetail: []string{"XJO in an uptrend"}},
		{name: "neutral passes", env: neutral, want: RulePass, wantDetail: []string{"XJO neutral"}},
		{name: "downtrend fails", env: down, want: RuleFail, wantValue: f(-5), wantDetail: []string{"downtrend"}},
	})
	u := ruleRegime(nil, &up)
	n := ruleRegime(nil, &neutral)
	if !(u.Strength > n.Strength) {
		t.Errorf("uptrend must grade stronger than neutral: %v vs %v", u.Strength, n.Strength)
	}
}

func TestRuleRS(t *testing.T) {
	runRuleCases(t, ruleRS, []ruleCase{
		{name: "null", cand: Candidate{}, want: RuleUnknown},
		{name: "positive", cand: Candidate{RS3mPct: f(12.3)}, want: RulePass, wantValue: f(12.3), wantDetail: []string{"Beat the S&P/ASX 200 by 12.3 points"}},
		{name: "tiny positive", cand: Candidate{RS3mPct: f(0.01)}, want: RulePass, wantValue: f(0.01)},
		{name: "zero fails", cand: Candidate{RS3mPct: f(0)}, want: RuleFail, wantValue: f(0), wantDetail: []string{"Matched"}},
		{name: "negative", cand: Candidate{RS3mPct: f(-4)}, want: RuleFail, wantValue: f(-4), wantDetail: []string{"Lagged the S&P/ASX 200 by 4.0 points"}},
	})
}

func TestRuleLiquidity(t *testing.T) {
	runRuleCases(t, ruleLiquidity, []ruleCase{
		{name: "null", cand: Candidate{}, want: RuleUnknown},
		{name: "at floor", cand: Candidate{DollarVolume20d: f(250_000)}, want: RulePass, wantValue: f(250_000), wantDetail: []string{"A$250k"}},
		{name: "below floor", cand: Candidate{DollarVolume20d: f(249_999)}, want: RuleFail, wantValue: f(249_999), wantDetail: []string{"below the A$250k floor"}},
		{name: "millions", cand: Candidate{DollarVolume20d: f(12_400_000)}, want: RulePass, wantValue: f(12_400_000), wantDetail: []string{"A$12.4m"}},
	})
	floor := ruleLiquidity(&Candidate{DollarVolume20d: f(250_000)}, &evalEnv{})
	deep := ruleLiquidity(&Candidate{DollarVolume20d: f(25_000_000)}, &evalEnv{})
	if floor.Strength != 0 || deep.Strength != 1 {
		t.Errorf("liquidity strength floor=%v (want 0) deep=%v (want 1)", floor.Strength, deep.Strength)
	}
}

func TestRuleNearHigh(t *testing.T) {
	runRuleCases(t, ruleNearHigh, []ruleCase{
		{name: "null", cand: Candidate{}, want: RuleUnknown},
		{name: "at high", cand: Candidate{PctOff52wHigh: f(0)}, want: RulePass, wantValue: f(0), wantDetail: []string{"At its 52-week high"}},
		{name: "at -5", cand: Candidate{PctOff52wHigh: f(-5)}, want: RulePass, wantValue: f(-5), wantDetail: []string{"5.0% below"}},
		{name: "at -5.01", cand: Candidate{PctOff52wHigh: f(-5.01)}, want: RuleFail, wantValue: f(-5.01), wantDetail: []string{"more than 5% away"}},
	})
}

func TestRuleOffHigh(t *testing.T) {
	runRuleCases(t, ruleOffHigh, []ruleCase{
		{name: "null", cand: Candidate{}, want: RuleUnknown},
		{name: "at -25", cand: Candidate{PctOff52wHigh: f(-25)}, want: RulePass, wantValue: f(-25)},
		{name: "at -25.1", cand: Candidate{PctOff52wHigh: f(-25.1)}, want: RuleFail, wantValue: f(-25.1), wantDetail: []string{"more than 25% away"}},
		{name: "at high", cand: Candidate{PctOff52wHigh: f(0)}, want: RulePass, wantValue: f(0)},
	})
}

func TestRuleRSLeader(t *testing.T) {
	q := evalEnv{rs6m: quartile{threshold: 20, max: 60, ok: true}}
	runRuleCases(t, ruleRSLeader, []ruleCase{
		{name: "null rs", cand: Candidate{}, env: q, want: RuleUnknown},
		{name: "no universe", cand: Candidate{RS6mPct: f(50)}, env: evalEnv{}, want: RuleUnknown},
		{name: "at cut-off", cand: Candidate{RS6mPct: f(20)}, env: q, want: RulePass, wantValue: f(20), wantDetail: []string{"top quartile", "+20.0"}},
		{name: "below cut-off", cand: Candidate{RS6mPct: f(19.9)}, env: q, want: RuleFail, wantValue: f(19.9), wantDetail: []string{"below the top-quartile cut-off of +20.0"}},
		{name: "the max", cand: Candidate{RS6mPct: f(60)}, env: q, want: RulePass, wantValue: f(60)},
	})
	top := ruleRSLeader(&Candidate{RS6mPct: f(60)}, &q)
	if top.Strength != 1 {
		t.Errorf("the universe max must grade 1, got %v", top.Strength)
	}
	flat := evalEnv{rs6m: quartile{threshold: 5, max: 5, ok: true}}
	if out := ruleRSLeader(&Candidate{RS6mPct: f(5)}, &flat); out.Status != RulePass || out.Strength != 1 {
		t.Errorf("a flat universe: %+v", out)
	}
}

func TestRuleTrendStack(t *testing.T) {
	runRuleCases(t, ruleTrendStack, []ruleCase{
		{name: "null 150", cand: Candidate{Close: 10, SMA200: f(8)}, want: RuleUnknown},
		{name: "null 200", cand: Candidate{Close: 10, SMA150: f(9)}, want: RuleUnknown},
		{name: "stacked", cand: Candidate{Close: 10, SMA150: f(9), SMA200: f(8)}, want: RulePass, wantValue: f(25), wantDetail: []string{"stacked in order"}},
		{name: "close equals 150 fails", cand: Candidate{Close: 9, SMA150: f(9), SMA200: f(8)}, want: RuleFail, wantValue: f(12.5), wantDetail: []string{"close is not above the 150-day"}},
		{name: "150 under 200 fails", cand: Candidate{Close: 10, SMA150: f(8), SMA200: f(9)}, want: RuleFail, wantDetail: []string{"150-day is not above the 200-day"},
			wantValue: f((10.0/9 - 1) * 100)},
	})
}

func TestRuleSMA200Rising(t *testing.T) {
	runRuleCases(t, ruleSMA200Rising, []ruleCase{
		{name: "null now", cand: Candidate{SMA200_1mAgo: f(8)}, want: RuleUnknown},
		{name: "null then", cand: Candidate{SMA200: f(8)}, want: RuleUnknown},
		{name: "rising", cand: Candidate{SMA200: f(8.4), SMA200_1mAgo: f(8)}, want: RulePass, wantValue: f(5)},
		{name: "flat fails", cand: Candidate{SMA200: f(8), SMA200_1mAgo: f(8)}, want: RuleFail, wantValue: f(0), wantDetail: []string{"not rising"}},
		{name: "falling", cand: Candidate{SMA200: f(7.6), SMA200_1mAgo: f(8)}, want: RuleFail, wantValue: f(-5)},
	})
}

func TestRuleAboveLow(t *testing.T) {
	runRuleCases(t, ruleAboveLow, []ruleCase{
		{name: "null", cand: Candidate{Close: 10}, want: RuleUnknown},
		{name: "zero low", cand: Candidate{Close: 10, Low52w: f(0)}, want: RuleUnknown},
		{name: "exactly 1.3x", cand: Candidate{Close: 13, Low52w: f(10)}, want: RulePass, wantValue: f(30)},
		{name: "exactly 1.3x with awkward floats", cand: Candidate{Close: 0.39, Low52w: f(0.3)}, want: RulePass, wantValue: f(30)},
		{name: "just under", cand: Candidate{Close: 12.99, Low52w: f(10)}, want: RuleFail, wantValue: f(29.9), wantDetail: []string{"under the 30% minimum"}},
		{name: "double the low", cand: Candidate{Close: 20, Low52w: f(10)}, want: RulePass, wantValue: f(100), wantDetail: []string{"100.0% above the 52-week low of A$10.00"}},
	})
}

func TestRuleAboveSMA50(t *testing.T) {
	runRuleCases(t, ruleAboveSMA50, []ruleCase{
		{name: "null", cand: Candidate{Close: 10}, want: RuleUnknown},
		{name: "above", cand: Candidate{Close: 11, SMA50: f(10)}, want: RulePass, wantValue: f(10)},
		{name: "equal fails", cand: Candidate{Close: 10, SMA50: f(10)}, want: RuleFail, wantValue: f(0)},
		{name: "below", cand: Candidate{Close: 9, SMA50: f(10)}, want: RuleFail, wantValue: f(-10)},
	})
}

func TestRuleShortInterest(t *testing.T) {
	runRuleCases(t, ruleShortInterest, []ruleCase{
		{name: "no reported position fails, it is not unknown", cand: Candidate{}, want: RuleFail, wantDetail: []string{"No reported short position"}},
		{name: "at 5", cand: Candidate{ShortPct: f(5)}, want: RulePass, wantValue: f(5), wantDetail: []string{"5.00% of shares on issue"}},
		{name: "under 5", cand: Candidate{ShortPct: f(4.99)}, want: RuleFail, wantValue: f(4.99), wantDetail: []string{"under 5%"}},
	})
}

func TestRuleDaysToCover(t *testing.T) {
	runRuleCases(t, ruleDaysToCover, []ruleCase{
		{name: "no short position fails", cand: Candidate{DaysToCover: f(9)}, want: RuleFail},
		{name: "no volume is unknown", cand: Candidate{ShortPct: f(8)}, want: RuleUnknown},
		{name: "at 5", cand: Candidate{ShortPct: f(8), DaysToCover: f(5)}, want: RulePass, wantValue: f(5)},
		{name: "under 5", cand: Candidate{ShortPct: f(8), DaysToCover: f(4.9)}, want: RuleFail, wantValue: f(4.9), wantDetail: []string{"under 5"}},
	})
}

func TestEveryRuleFuncHandlesAnEmptyCandidate(t *testing.T) {
	// A candidate with nothing but a code must never panic, and must never
	// pass a rule that needs data (except where absence is itself data).
	for id, fn := range ruleFuncs {
		out := fn(&Candidate{StockCode: "TST"}, &evalEnv{})
		if out.Status == RulePass {
			t.Errorf("%s passed on an empty candidate: %q", id, out.Detail)
		}
		if strings.TrimSpace(out.Detail) == "" {
			t.Errorf("%s returned an empty detail", id)
		}
	}
}

func TestFormatting(t *testing.T) {
	cases := map[string]string{
		money(999):                       "A$999",
		money(250_000):                   "A$250k",
		money(1_250_000):                 "A$1.2m",
		money(3_400_000_000):             "A$3.4b",
		moneyIn(4_290_000_000, "USD"):    "USD 4.3b",
		moneyIn(12_000, ""):              "A$12k",
		pct(12.34):                       "+12.3%",
		pct(-0.05):                       "-0.1%",
		price(0.5):                       "A$0.50",
		sentence([]string{"swung", "b"}): "Swung; b",
		sentence(nil):                    "",
	}
	for got, want := range cases {
		if got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	}
	if clamp01(math.NaN()) != 0 || clamp01(-1) != 0 || clamp01(2) != 1 || clamp01(0.4) != 0.4 {
		t.Error("clamp01")
	}
}
