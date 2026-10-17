package picks

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The sign of a filing net income or EPS (review findings C3 and C6). The
// sign comes from the matched number itself (a minus or parentheses), else
// from the nearest sign word BEFORE it in its clause, else from a sign word
// immediately after it. A sign word inside parentheses, inside a comparison
// ("compared with a net profit of $5.0m", "up from a loss of $3.1m") or in a
// statement name ("statement of profit or loss") says nothing about the
// quoted figure. When the words (or the value attribute) disagree, the value
// is withheld: sign_ambiguous, counted at gate 5.

func TestFilingMoneySign(t *testing.T) {
	cases := []struct {
		text, value string
		want        float64
		why         string
	}{
		// C3: a loss quote that also names a profit.
		{"Net loss after tax attributable to members of $12.3 million, compared with a net profit of $5.0 million in the prior corresponding period", "12.3", -12.3e6, "C3: the comparative profit is not the figure's"},
		{"Loss after tax of $12.3m (pcp: profit $5.0m)", "12.3", -12.3e6, "C3: a profit in parentheses is not the figure's"},
		{"The consolidated statement of profit or loss shows a net loss after tax of $12.3 million", "12.3", -12.3e6, "C3: a statement name is not a sign word"},
		{"The statement of profit or loss shows a net loss after tax of $12.3 million", "12.3", -12.3e6, "C3: a statement name is not a sign word"},
		// C6: a profit quote that also names a prior loss.
		{"NPAT of $45.2 million, up from a loss of $3.1 million in the prior corresponding period", "45.2", 45.2e6, "C6: NPAT is a profit word; the prior loss is a comparative"},
		{"Statutory NPAT of $45.2 million (pcp: loss of $3.1 million)", "45.2", 45.2e6, "C6: a loss in parentheses is not the figure's"},
		{"Net result after tax attributable to members of $45.2 million compared with a loss of $3.1 million", "45.2", 45.2e6, "C6: a loss after a comparison lead is not the figure's"},
		// Mirrors.
		{"Net loss after tax of $3.1 million, compared with a profit of $2.0 million in the pcp", "3.1", -3.1e6, "C6 mirror: the comparative profit does not suppress the loss"},
		{"Net profit after tax of $45.2 million, compared with a net loss of $3.1 million in the pcp", "45.2", 45.2e6, "the comparative loss does not flip the profit"},
		{"The statement of profit or loss shows a net profit after tax of $45.2 million", "45.2", 45.2e6, "a statement name is not a sign word"},
		// A comparison before the figure: its sign word describes the comparative.
		{"Up from a loss of $3.1 million in the prior year, the result after tax was $45.2 million", "45.2", 45.2e6, "the comparison ends at its own figure"},
		{"Profit after tax improved from a loss of $3.1 million to $45.2 million", "45.2", 45.2e6, "the loss belongs to the from-figure"},
		{"Turnaround from a loss of $3.1 million to $45.2 million", "45.2", 45.2e6, "no sign word governs the figure"},
		{"Net loss narrowed from $20.0 million to $12.3 million", "12.3", -12.3e6, "the loss word precedes the comparison"},
		{"Swung from a profit of $5.0 million to a net loss of $12.3 million", "12.3", -12.3e6, "the nearest sign word before the figure"},
		{"Swung from a loss of $3.1m to $45.2m profit", "45.2", 45.2e6, "a profit word right after the figure"},
		// A sign word right after the figure.
		{"Net result after tax of $12.3 million loss", "12.3", -12.3e6, "a loss word right after the figure"},
		{"Net result after tax 12.3m net loss after tax, compared with a profit of $5.0m", "12.3", -12.3e6, "a loss phrase right after the figure, before the comparison"},
		// Partial items and table labels.
		{"NPAT, after impairment losses, was $45.2 million", "45.2", 45.2e6, "an impairment loss is a partial item, not the figure's sign"},
		{"Profit/(loss) after tax ($m) 45.2", "45.2", 45.2e6, "a profit/(loss) line: unsigned is a profit"},
		{"Profit/(loss) after tax ($m) (12.3)", "12.3", -12.3e6, "a profit/(loss) line: parenthesised is a loss"},
		// The number's own sign decides.
		{"Net profit after tax of ($3.2m)", "-3.2", -3.2e6, "a parenthesised money figure is negative"},
		{"Net profit after tax of ($3.2m)", "3.2", -3.2e6, "a parenthesised money figure is negative whatever the attribute"},
		{"Net loss after tax of $3.2 million", "-3.2", -3.2e6, "a signed attribute agreeing with the words"},
		{"Net result after tax of $3.2 million", "-3.2", -3.2e6, "a signed attribute with no sign word"},
		{"Net loss after tax (US$12.3m)", "12.3", -12.3e6, "a parenthesised US$ figure"},
		{"Profit after tax -US$12.3m", "12.3", -12.3e6, "a minus before the currency"},
		{"NPAT of $45.2m (pcp $40.1m)", "45.2", 45.2e6, "a comparative in parentheses is not a wrapped negative"},
		{"Statutory net profit after tax (NPAT) attributable to members was $612 million", "612", 612e6, "an abbreviation in parentheses"},
		// Comparative-period tags.
		{"Net loss after tax up from $3.1m in the pcp to $12.3m", "12.3", -12.3e6, "the tagged comparative starts at its lead; the loss before it governs"},
		{"Revenue of $98.4m, up from $90.1m in the pcp, and net loss of $12.3m", "12.3", -12.3e6, "a tagged comparative with no sign word"},
		{"Net loss after tax attributable to members of the parent entity was $12.3 million, an improvement on the prior year loss of $20.1 million", "12.3", -12.3e6, "the prior-year loss follows the figure"},
		{"Profit after income tax expense for the half-year attributable to the owners of XYZ Limited $45,213,000 (31 December 2024: loss $3,100,000)", "45.213", 45.213e6, "a 4D directors' report line"},
		{"Loss after income tax expense for the half-year $12,345,678 (31 December 2024: profit $3,100,000)", "12.345678", -12.345678e6, "a 4D directors' report line"},
	}
	for _, c := range cases {
		got, reason, ok := filingMoney(entry("source_text", c.text, "value_millions", c.value), "net_income", "")
		if assert.True(t, ok, "%q rejected (%s): %s", c.text, reason, c.why) {
			assert.InDelta(t, c.want, got, 1e-3, "%q: %s", c.text, c.why)
		}
	}

	ambiguous := []struct{ text, value, why string }{
		{"NPAT of $12.3 million loss", "12.3", "a profit word before and a loss word after"},
		{"Net loss after tax of $12.3 million profit", "12.3", "a loss word before and a profit word after"},
		{"Net profit after tax of $12.3 million", "-12.3", "the attribute contradicts the words"},
		{"A loss of $3.1 million in the pcp became $45.2 million", "45.2", "the nearest sign word is a tagged comparative's"},
		{"Loss of $3.1m in the pcp widened to $12.3m", "12.3", "the nearest sign word is a tagged comparative's"},
		{"Net loss after tax of $3.1 million in the pcp and $12.3 million in the current half", "12.3", "the nearest sign word is a tagged comparative's"},
	}
	for _, c := range ambiguous {
		_, reason, ok := filingMoney(entry("source_text", c.text, "value_millions", c.value), "net_income", "")
		assert.False(t, ok, "%q accepted: %s", c.text, c.why)
		assert.Equal(t, reasonSignAmbiguous, reason, "%q: %s", c.text, c.why)
	}

	// Revenue is never signed by words, and a parenthesised figure is refused.
	got, _, ok := filingMoney(entry("source_text", "Revenue of $98.4 million, compared with a loss of $3.1 million", "value_millions", "98.4"), "revenue", "")
	require.True(t, ok)
	assert.InDelta(t, 98.4e6, got, 1e-3)
	_, _, ok = filingMoney(entry("source_text", "Revenue of ($98.4m)", "value_millions", "98.4"), "revenue", "")
	assert.False(t, ok, "a parenthesised revenue is negative")
}

func TestFilingEPSSign(t *testing.T) {
	cases := []struct {
		text, key, value string
		want             float64
		why              string
	}{
		// C6: a profit EPS whose quote names a prior loss per share.
		{"Basic earnings per share 12.3 cents (pcp: loss per share of 0.8 cents)", "value_cents", "12.3", 0.123, "C6: the loss per share in parentheses is the pcp's"},
		{"Basic earnings per share 12.3 cents compared to a loss per share of 0.8 cents", "value_cents", "12.3", 0.123, "C6: a loss after a comparison lead"},
		{"Basic EPS 12.3 cents, up from negative 0.8 cents", "value_cents", "12.3", 0.123, "C6: negative after a comparison lead"},
		{"EPS up from a loss per share of 0.8 cents to 12.3 cents", "value_cents", "12.3", 0.123, "the loss belongs to the from-figure"},
		{"Basic earnings/(loss) per share 12.3 cents", "value_cents", "12.3", 0.123, "an earnings/(loss) line: unsigned is earnings"},
		// Mirrors.
		{"Basic loss per share 3.4 cents (pcp: earnings per share 1.4 cents)", "value_cents", "3.4", -0.034, "C6 mirror: pcp earnings in parentheses"},
		{"Loss per share of 3.4 cents, compared with earnings per share of 1.4 cents", "value_cents", "3.4", -0.034, "C6 mirror: earnings after a comparison lead"},
		{"Basic EPS negative 3.4 cents", "value_cents", "3.4", -0.034, "negative is a loss word"},
		{"Basic earnings/(loss) per share (3.4) cents", "value_cents", "3.4", -0.034, "parenthesised is negative"},
		{"Earnings per share: basic loss per share 3.4 cents", "value_cents", "3.4", -0.034, "the nearest sign word before the figure"},
		{"Basic EPS ($0.03)", "value", "0.03", -0.03, "a parenthesised dollar EPS is negative"},
	}
	for _, c := range cases {
		got, reason, ok := filingEPS(entry("source_text", c.text, c.key, c.value))
		if assert.True(t, ok, "%q rejected (%s): %s", c.text, reason, c.why) {
			assert.InDelta(t, c.want, got.dollars, 1e-12, "%q: %s", c.text, c.why)
		}
	}

	ambiguous := []struct{ text, value, why string }{
		{"Basic EPS 3.4 cents loss per share", "3.4", "an EPS word before and a loss word after"},
		{"Basic earnings per share 12.3 cents", "-12.3", "the attribute contradicts the words"},
	}
	for _, c := range ambiguous {
		_, reason, ok := filingEPS(entry("source_text", c.text, "value_cents", c.value))
		assert.False(t, ok, "%q accepted: %s", c.text, c.why)
		assert.Equal(t, reasonSignAmbiguous, reason, "%q: %s", c.text, c.why)
	}
}

// Gate 8's EPS / net income ratio is sign-blind when both flip, so a pair
// flipped by the same comparative word passed it together (C6). The pair is
// now read right, and a sign_ambiguous net income takes the half's EPS with
// it (nothing left to check it against).
func TestGate8FlippedPairNoLongerPasses(t *testing.T) {
	vendor := map[string][]vendorRow{"TRN": {
		// FY25: a loss of $3.1m on 367m shares.
		vAnnual("2025-06-30", "AUD", f64(400e6), f64(-3.1e6), f64(-0.0084), f64(367e6)),
	}}
	doc := func(m map[string]any) []filingExtraction {
		return []filingExtraction{{Code: "TRN", URL: "u-4d", Title: "Appendix 4D and Half Year Financial Report", ReportDate: date("2026-02-20"), Metrics: metricsJSON(t, m)}}
	}

	// The turnaround half: a profit, with the prior loss in the same quotes.
	var st filingStats
	out := buildFilingRows(doc(map[string]any{
		"revenue":    entry("source_text", "Revenue from ordinary activities $210.4 million", "value_millions", "210.4", "period", "H1 FY2026", "alignment", "match_exact"),
		"net_profit": entry("source_text", "NPAT of $45.2 million, up from a loss of $3.1 million in the prior corresponding period", "value_millions", "45.2", "period", "H1 FY2026", "alignment", "match_exact"),
		"eps":        entry("source_text", "Basic earnings per share 12.3 cents (pcp: loss per share of 0.8 cents)", "value_cents", "12.3", "period", "H1 FY2026", "alignment", "match_exact"),
	}), filingInputs{vendor: vendor}, &st)
	require.Len(t, out["TRN"], 1)
	r := out["TRN"][0]
	assert.InDelta(t, 45.2e6, val(t, r.NetIncome), 1, "a profit, not -45.2m")
	assert.InDelta(t, 0.123, val(t, r.EPSBasic), 1e-12, "a profit EPS, not -0.123")
	assert.Empty(t, st.Gates, "nothing withheld: %v", st.Gates)

	// The loss half (C3's shape): both read as losses and pass together.
	st = filingStats{}
	out = buildFilingRows(doc(map[string]any{
		"net_profit": entry("source_text", "Net loss after tax attributable to members of $12.3 million, compared with a net profit of $5.0 million in the prior corresponding period", "value_millions", "12.3", "period", "H1 FY2026", "alignment", "match_exact"),
		"eps":        entry("source_text", "Basic loss per share 3.4 cents (pcp: earnings per share 1.4 cents)", "value_cents", "3.4", "period", "H1 FY2026", "alignment", "match_exact"),
	}), filingInputs{vendor: map[string][]vendorRow{"TRN": {
		vAnnual("2025-06-30", "AUD", f64(400e6), f64(5e6), f64(0.0138), f64(362e6)),
	}}}, &st)
	require.Len(t, out["TRN"], 1)
	r = out["TRN"][0]
	assert.InDelta(t, -12.3e6, val(t, r.NetIncome), 1, "a loss, not +12.3m")
	assert.InDelta(t, -0.034, val(t, r.EPSBasic), 1e-12)
	assert.Empty(t, st.Gates, "nothing withheld: %v", st.Gates)

	// A net income whose quote does not settle its sign is withheld, and the
	// half's EPS goes with it: gate 8 has no net income to check it against.
	st = filingStats{}
	out = buildFilingRows(doc(map[string]any{
		"revenue":    entry("source_text", "Revenue from ordinary activities $210.4 million", "value_millions", "210.4", "period", "H1 FY2026", "alignment", "match_exact"),
		"net_profit": entry("source_text", "NPAT of $45.2 million loss", "value_millions", "45.2", "period", "H1 FY2026", "alignment", "match_exact"),
		"eps":        entry("source_text", "Basic earnings per share 12.3 cents (pcp: loss per share of 0.8 cents)", "value_cents", "12.3", "period", "H1 FY2026", "alignment", "match_exact"),
	}), filingInputs{vendor: vendor}, &st)
	require.Len(t, out["TRN"], 1)
	r = out["TRN"][0]
	assert.Nil(t, r.NetIncome)
	assert.Nil(t, r.EPSBasic)
	assert.InDelta(t, 210.4e6, val(t, r.Revenue), 1)
	assert.Equal(t, 1, st.Gates[gateSignAmbiguous])
	assert.Equal(t, 1, st.Gates[gateEPSUncheckable])
}
