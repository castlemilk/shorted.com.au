package picks

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// Every headline here is carried over from
// scripts/take-writer/src/results-watch.test.ts, where each one is a REAL
// asx_announcements headline. If the TypeScript classifier changes, port the
// change and its cases here too.
func TestClassifyResultsFiling(t *testing.T) {
	cases := []struct {
		headline string
		want     filingKind
	}{
		// real filings
		{"Appendix 4E & Financial Report for year ended 30 June 2026", filingAppendix4DE},
		{"FY26 Appendix 4E and Annual Report", filingAppendix4DE},
		{"Appendix 4E & Annual Report for Year Ending 30 June 2026", filingAppendix4DE},
		{"Annual Report to shareholders", filingAnnualReport},
		{"FY26 Financial Results and Dividend", filingPeriodResults},
		{"FY26 Results Release", filingPeriodResults},
		// near-misses
		{"FY26 Results Date and Market Briefing", ""},
		{"AMX to present FY26 Results at Coffee Microcaps Webinar", ""},
		{"Advanced Braking Technology FY26 Results Webinar", ""},
		{"Dividend/Distribution - AMA", ""},
		{"Update - Dividend/Distribution - ALK", ""},
		{"Confirmation of Final Dividend Payment Date", ""},
		{"Trading Halt", ""},
		{"Change of Director's Interest Notice", ""},
		{"Quarterly Activities Report", ""},
		{"Notice of Annual General Meeting", ""},
		{"", ""},
		{"FY26 Dividend Declared and On-Market Share Buy-Back", ""},
		// regressions found over 632 real headlines
		{"Media Release - Result for year ended 30 June 2026", filingPeriodResults},
		{"FY26 Financial Results Release and Webinar", filingPeriodResults},
		{"Neuren H1 2026 Financial Results Webinar on 26 August 2026", ""},
		{"Results of Meeting", ""},
		{"Results of 2025 Annual General Meeting", ""},
		{"Results of General Meeting - Share Issue Approvals", ""},
		// regressions found against prod
		{"Notice of FY26 Results Market Briefing", ""},
		{"PolyNovo FY26 Results Presentation - Registration Details", ""},
		{"2026 GYG Full Year Report and Appendix 4E", filingAppendix4DE},
		{"Telix HY26 Results Announcement", filingPeriodResults},
		{"Media Release - Full Year Results to 30 June 2026", filingPeriodResults},
		// DroneShield's own history (December year end, half-year in August)
		{"Half Yearly Report and Accounts", filingPeriodResults},
		{"1H25 Results Surging Revenue and Profitability", filingPeriodResults},
		{"2H26 Results", filingPeriodResults},
		{"Appendix 4E - Preliminary Final Report", filingAppendix4DE},
		{"Appendix 4D and FY26 Half Year Report", filingAppendix4DE},
		{"FY2025 Full year results", filingPeriodResults},
		{"Quarterly Activities/Appendix 4C Cash Flow Report", ""},
		{"Quarterly Activity Report and Appendix 4C", ""},
		{"1Q26 4C Results - Investor Presentation", ""},
	}
	for _, c := range cases {
		assert.Equal(t, c.want, classifyResultsFiling(c.headline), "%q", c.headline)
	}
}
