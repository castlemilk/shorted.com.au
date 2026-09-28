package strategies

import (
	"reflect"
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
