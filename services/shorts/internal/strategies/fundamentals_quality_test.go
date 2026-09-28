package strategies

import (
	"math"
	"reflect"
	"strings"
	"testing"
)

func TestNotMeaningfulForFinancialsIsTheContractList(t *testing.T) {
	// Plan fundamentals-coverage.md §2.7, verbatim and in order.
	want := []string{"gross_margin_pct", "operating_margin_pct", "fcf_margin_pct", "fcf_conversion",
		"net_debt", "net_debt_to_ebitda", "net_debt_to_equity", "current_ratio", "interest_cover"}
	got := NotMeaningfulForFinancials()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("NotMeaningfulForFinancials() = %v, want %v", got, want)
	}
	got[0] = "mutated"
	if NotMeaningfulForFinancials()[0] != "gross_margin_pct" {
		t.Fatal("the exported list must be a copy")
	}
	var q Quality
	for _, name := range want {
		if q.ratioField(name) == nil {
			t.Errorf("%s has no field", name)
		}
	}
	if q.ratioField("roe_pct") != nil {
		t.Error("ROE is meaningful for a bank and must not be on the list")
	}
}

func TestIsFinancial(t *testing.T) {
	cases := []struct {
		name     string
		q        *Quality
		industry string
		want     bool
	}{
		{"bank by industry", nil, "Banks", true},
		{"insurer by industry, any case and spacing", nil, "  INSURANCE ", true},
		{"a miner", &Quality{OperatingIncome: f(1), EBITDA: f(2)}, "Materials", false},
		{"statement shape alone", &Quality{StatementIsFinancial: true}, "Software & Services", true},
		{"financial services without a quality row", nil, "Financial Services", false},
		{"financial services, a lender by debt", &Quality{TotalDebt: f(50), TotalAssets: f(100)}, "Financial Services", true},
		{"financial services, just under the debt test", &Quality{TotalDebt: f(49.9), TotalAssets: f(100)}, "Financial Services", false},
		{"financial services, a lender by net interest income", &Quality{NetInterestIncome: f(26), Revenue: f(100)}, "Financial Services", true},
		{"financial services, net interest income at exactly a quarter", &Quality{NetInterestIncome: f(25), Revenue: f(100)}, "Financial Services", false},
		{"pre-2023 group name", &Quality{TotalDebt: f(60), TotalAssets: f(100)}, "Diversified Financials", true},
		{"an exchange or fund manager is not a lender", &Quality{TotalDebt: f(5), TotalAssets: f(100), NetInterestIncome: f(-1), Revenue: f(100)}, "Financial Services", false},
		{"net interest income never classifies outside financials", &Quality{NetInterestIncome: f(90), Revenue: f(100)}, "Capital Goods", false},
		{"no assets figure is not a lender", &Quality{TotalDebt: f(50)}, "Financial Services", false},
	}
	for _, tc := range cases {
		if got := IsFinancial(tc.q, tc.industry); got != tc.want {
			t.Errorf("%s: IsFinancial = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestIsProperty(t *testing.T) {
	for _, ind := range []string{"Equity Real Estate Investment Trusts (REITs)", "real estate management & development"} {
		if !IsProperty(ind) {
			t.Errorf("%q is property", ind)
		}
	}
	for _, ind := range []string{"", "Banks", "Real Estate", "Materials"} {
		if IsProperty(ind) {
			t.Errorf("%q is not property", ind)
		}
	}
}

func TestApplyQualityRulesWithholdsOnlyTheListForFinancials(t *testing.T) {
	full := func() *Quality {
		return &Quality{
			Revenue: f(100), NetIncome: f(20), TotalDebt: f(900), TotalAssets: f(1000), CashAndEquivalents: f(10),
			GrossMarginPct: f(1), OperatingMarginPct: f(2), NetMarginPct: f(20), FCFMarginPct: f(3), FCFConversion: f(4),
			ROEPct: f(12), ROAPct: f(1), NetDebt: f(5), NetDebtToEBITDA: f(6), NetDebtToEquity: f(7),
			CurrentRatio: f(8), InterestCover: f(9), PayoutRatioPct: f(70),
		}
	}
	bank := full()
	ApplyQualityRules(bank, "Banks")
	if !bank.IsFinancial || bank.IsProperty {
		t.Fatalf("flags: %+v", bank)
	}
	if !reflect.DeepEqual(bank.NotMeaningful, NotMeaningfulForFinancials()) {
		t.Errorf("not_meaningful = %v", bank.NotMeaningful)
	}
	for _, name := range NotMeaningfulForFinancials() {
		if *bank.ratioField(name) != nil {
			t.Errorf("%s must be withheld for a bank", name)
		}
		if !bank.IsNotMeaningful(name) {
			t.Errorf("IsNotMeaningful(%s) = false", name)
		}
	}
	if bank.ROEPct == nil || bank.ROAPct == nil || bank.NetMarginPct == nil || bank.PayoutRatioPct == nil {
		t.Error("ROE, ROA, net margin and payout stay meaningful for a bank")
	}
	if bank.TotalDebt == nil || bank.CashAndEquivalents == nil {
		t.Error("statement lines are never withheld, only ratios")
	}
	before := *bank
	ApplyQualityRules(bank, "Banks")
	if !reflect.DeepEqual(before, *bank) {
		t.Error("ApplyQualityRules is not idempotent")
	}

	reit := full()
	ApplyQualityRules(reit, "Equity Real Estate Investment Trusts (REITs)")
	if reit.IsFinancial || !reit.IsProperty || reit.NotMeaningful != nil || reit.FCFConversion == nil || reit.NetDebt == nil {
		t.Errorf("a REIT keeps its ratios and is flagged property: %+v", reit)
	}
	ApplyQualityRules(nil, "Banks") // no panic

	isFin, isProp, nm := FinancialFlags(nil, "Insurance")
	if !isFin || isProp || len(nm) != len(notMeaningfulForFinancials) {
		t.Errorf("FinancialFlags(nil, Insurance) = %v %v %v", isFin, isProp, nm)
	}
	if isFin, _, nm := FinancialFlags(nil, "Materials"); isFin || nm != nil {
		t.Errorf("FinancialFlags(nil, Materials) = %v %v", isFin, nm)
	}
}

// The view withholds roe_pct below 10% equity to assets, which is every major
// bank (CBA: about 6%). For a financial, Go computes it exactly as the view
// does without that guard: flow-row net income over the average of the two
// aligned equity points, both > 0. Every other company keeps the guard.
func TestApplyQualityRulesComputesROEForAFinancialTheViewWithheld(t *testing.T) {
	cba := func() *Quality { // the view's row: roe_pct NULL, everything to compute it present
		return &Quality{
			Revenue: f(27e9), NetIncome: f(10e9), NetMarginPct: f(37),
			TotalEquity: f(78e9), TotalEquityPrior: f(75e9), TotalAssets: f(1.3e12), TotalAssetsPrior: f(1.25e12),
			ROAPct: f(10.0 / 1275 * 100),
		}
	}
	want := 10e9 / ((78e9 + 75e9) / 2) * 100 // 13.07%

	bank := cba()
	ApplyQualityRules(bank, "Banks")
	if bank.ROEPct == nil || math.Abs(*bank.ROEPct-want) > 1e-9 {
		t.Fatalf("a bank's ROE = %v, want %v", bank.ROEPct, want)
	}
	if bank.IsNotMeaningful("roe_pct") {
		t.Error("ROE is never listed as not meaningful")
	}
	before := *bank
	ApplyQualityRules(bank, "Banks")
	if !reflect.DeepEqual(before, *bank) {
		t.Error("ApplyQualityRules is not idempotent once ROE is computed")
	}

	// A statement-shaped financial with no industry gets it too.
	shaped := cba()
	shaped.StatementIsFinancial = true
	ApplyQualityRules(shaped, "")
	if shaped.ROEPct == nil || math.Abs(*shaped.ROEPct-want) > 1e-9 {
		t.Errorf("a statement-flagged financial's ROE = %v", shaped.ROEPct)
	}

	// The same numbers outside financials keep the view's guard.
	miner := cba()
	ApplyQualityRules(miner, "Materials")
	if miner.ROEPct != nil {
		t.Errorf("a non-financial keeps the 10%% guard: ROE %v", *miner.ROEPct)
	}

	// A ratio the view did compute is never replaced.
	kept := cba()
	kept.ROEPct = f(11)
	ApplyQualityRules(kept, "Banks")
	if *kept.ROEPct != 11 {
		t.Errorf("the view's ROE was overwritten: %v", *kept.ROEPct)
	}

	// No single-point fallback, and no ROE on a non-positive equity point.
	for name, mutate := range map[string]func(q *Quality){
		"no prior equity":   func(q *Quality) { q.TotalEquityPrior = nil },
		"no equity":         func(q *Quality) { q.TotalEquity = nil },
		"no net income":     func(q *Quality) { q.NetIncome = nil },
		"zero prior equity": func(q *Quality) { q.TotalEquityPrior = f(0) },
		"negative equity":   func(q *Quality) { q.TotalEquity = f(-1e9) },
		"non-finite income": func(q *Quality) { q.NetIncome = f(math.Inf(1)) },
	} {
		q := cba()
		mutate(q)
		ApplyQualityRules(q, "Banks")
		if q.ROEPct != nil {
			t.Errorf("%s: ROE %v, want none", name, *q.ROEPct)
		}
	}

	// A loss is a negative return, not an unknown one.
	loss := cba()
	loss.NetIncome = f(-1.53e9)
	ApplyQualityRules(loss, "Insurance")
	if loss.ROEPct == nil || math.Abs(*loss.ROEPct-(-2)) > 1e-9 {
		t.Errorf("an insurer's loss: ROE %v, want -2", loss.ROEPct)
	}
}

// Every surface reads the decided row, so the ROE rule and the sort judge a
// bank on the figure Go computed rather than reading it as unknown.
func TestBankROEReachesTheRuleAndTheSort(t *testing.T) {
	bankQuality := func(ni float64) *Quality {
		return &Quality{
			Revenue: f(27e9), NetIncome: f(ni), NetMarginPct: f(ni / 27e9 * 100),
			TotalEquity: f(78e9), TotalEquityPrior: f(75e9), TotalAssets: f(1.3e12), TotalAssetsPrior: f(1.25e12),
			BasisPeriodType: "annual", BasisPeriodEnd: d("2026-06-30"),
		}
	}
	cands := []Candidate{
		{StockCode: "BNK", Industry: "Banks", Close: 150, AsOf: *d("2026-09-25"), Quality: bankQuality(12e9)},
		{StockCode: "LOW", Industry: "Banks", Close: 30, AsOf: *d("2026-09-25"), Quality: bankQuality(6e9)},
		{StockCode: "MIN", Industry: "Materials", Close: 45, AsOf: *d("2026-09-25"), Quality: bankQuality(12e9)},
	}
	PrepareCandidates(cands)

	if r := ruleROE(&cands[0], nil); r.Status != RulePass {
		t.Errorf("a bank earning 15.7%% on equity passes the ROE rule: %+v", r)
	}
	if r := ruleROE(&cands[1], nil); r.Status != RuleFail || !strings.Contains(r.Detail, "below the 15% threshold") {
		t.Errorf("a bank earning 7.8%% fails it: %+v", r)
	}
	if r := ruleROE(&cands[2], nil); r.Status != RuleUnknown || !strings.Contains(r.Detail, "outside banks, insurers and other financials") {
		t.Errorf("a non-financial under 10%% equity to assets reads unknown, and says why: %+v", r)
	}

	picks := make([]Pick, len(cands))
	for i := range cands {
		picks[i] = Pick{Candidate: cands[i], Rank: i + 1}
	}
	if got := sortedCodes(SortPicks(picks, SortROE)); !reflect.DeepEqual(got, []string{"BNK", "LOW", "MIN"}) {
		t.Errorf("roe order = %v: the banks sort on their computed ROE, the guarded miner last", got)
	}
}
