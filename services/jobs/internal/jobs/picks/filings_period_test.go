package picks

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

	"github.com/castlemilk/shorted.com.au/services/pkg/extractiontrust"
)

// resolveForTest is what buildFilingRows does per metric: the document gate
// (gate 1), then the period parser.
func resolveForTest(period, headline, reportDate string, vendorFYE time.Month) (resolvedPeriod, string, bool) {
	if !extractiontrust.IsResultsDocument(headline, "") {
		return resolvedPeriod{}, "headline: not a results document", false
	}
	var rd time.Time
	if reportDate != "" {
		rd = date(reportDate)
	}
	return parsePeriod(period, periodContext{Headline: headline, ReportDate: rd, VendorFYE: vendorFYE})
}

// Headlines are real asx_announcements shapes (several carried over from
// results-watch.test.ts); period strings are the shapes the extractor's
// Gemini prompt produces (its few-shot uses "H1 FY2025" / "FY2025").
func TestParsePeriodAccepts(t *testing.T) {
	cases := []struct {
		period, headline, reportDate string
		vendorFYE                    time.Month
		wantType, wantEnd            string
		why                          string
	}{
		{"H1 FY2025", "Appendix 4D - Half Year Report", "2025-02-20", time.June, periodHalf, "2024-12-31", "H1 of a June year ends 31 December of the prior calendar year"},
		{"1H26", "1H26 Results Announcement", "2026-02-18", time.June, periodHalf, "2025-12-31", "the 1H26 convention"},
		{"1HFY26", "Appendix 4D", "2026-02-26", time.June, periodHalf, "2025-12-31", "run together"},
		{"HY25", "HY25 Results Release", "2025-02-19", time.June, periodHalf, "2024-12-31", "HY is the first half"},
		{"half-year ended 31 December 2024", "Half Year Financial Report", "2025-02-26", 0, periodHalf, "2024-12-31", "explicit date"},
		{"six months to 31 December 2025", "Half Yearly Report and Accounts", "2026-02-25", 0, periodHalf, "2025-12-31", "six months = half"},
		{"H1 FY2026", "Appendix 4D and FY26 Half Year Report", "2026-08-27", time.December, periodHalf, "2026-06-30", "December balance date (DroneShield): H1 FY26 ends 30 June 2026"},
		{"2H25", "2H25 Results", "2025-08-20", time.June, periodHalf, "2025-06-30", "a second half ends with the year"},
		{"FY2025", "Appendix 4E and Annual Report", "2025-08-20", time.June, periodAnnual, "2025-06-30", "FY label on the vendor's June balance date"},
		{"FY25", "FY25 Results", "2025-08-14", time.June, periodAnnual, "2025-06-30", "two-digit FY"},
		{"full year ended 30 June 2025", "Preliminary Final Report", "2025-08-25", 0, periodAnnual, "2025-06-30", "explicit full-year date"},
		{"year ended 31 December 2025", "Appendix 4E - Preliminary Final Report", "2026-02-24", 0, periodAnnual, "2025-12-31", "December year, explicit"},
		{"FY2025/26", "Annual Report 2026", "2026-09-25", time.June, periodAnnual, "2026-06-30", "a span names the year it ends in"},
		{"FY2025", "Appendix 4E - Preliminary Final Report for year ended 31 December 2025", "2026-02-24", 0, periodAnnual, "2025-12-31", "balance month from the dated headline"},
		{"FY2025", "FY25 Results", "2026-02-24", time.December, periodAnnual, "2025-12-31", "balance month from the vendor's rows"},
		{"52 weeks ended 29 June 2025", "Appendix 4E", "2025-08-18", 0, periodAnnual, "2025-06-30", "52/53-week year: type from the 4E headline, date folded to the month end"},
		{"CY2025", "Appendix 4E", "2026-02-26", 0, periodAnnual, "2025-12-31", "calendar year forces December"},
		{"period ended 31 December 2025", "Appendix 4D", "2026-02-20", 0, periodHalf, "2025-12-31", "no type word: the 4D headline says half"},
		{"H1", "Appendix 4D Half Year Report", "2026-02-20", time.June, periodHalf, "2025-12-31", "no year: the latest H1 end before the report"},
		{"", "Appendix 4E & Financial Report for year ended 30 June 2026", "2026-08-20", 0, periodAnnual, "2026-06-30", "no period attribute: the headline's own"},
		{"FY26", "FY26 Financial Results Release and Webinar", "2026-08-19", time.June, periodAnnual, "2026-06-30", "a strong marker overrides the webinar exclusion"},
		{"H1 FY2025", "Appendix 4D", "", time.June, periodHalf, "2024-12-31", "no report date: a labelled year still resolves"},
		// Regression: a dated half-year headline ending 31 December once put
		// the balance date in JULY (AddDate(0, 6, 0) on the 31st overflows),
		// so H1 landed on 31 January. Found by the scratch-Postgres run.
		{"H1 FY2026", "BHP Results for the half year ended 31 December 2025", "2026-02-17", 0, periodHalf, "2025-12-31", "dated half-year headline: the year ends six months after it"},
		{"1H25", "Half Year Report for the half year ended 30 June 2025", "2025-08-27", 0, periodHalf, "2025-06-30", "a December-year company's dated half headline"},
	}
	for _, c := range cases {
		got, reason, ok := resolveForTest(c.period, c.headline, c.reportDate, c.vendorFYE)
		if assert.True(t, ok, "%q / %q rejected (%s): %s", c.period, c.headline, reason, c.why) {
			assert.Equal(t, c.wantType, got.Type, "%q / %q: %s", c.period, c.headline, c.why)
			assert.Equal(t, c.wantEnd, got.End.Format("2006-01-02"), "%q / %q: %s", c.period, c.headline, c.why)
		}
	}
}

func TestParsePeriodRejects(t *testing.T) {
	cases := []struct {
		period, headline, reportDate string
		why                          string
	}{
		// headline traps
		{"FY26", "FY26 Results Date and Market Briefing", "2026-07-20", "scheduling notice"},
		{"FY25", "FY25 Results Presentation", "2025-08-14", "a presentation is not the statutory document (gate 1)"},
		{"FY2025", "Appendix 4E", "2025-08-20", "no balance date: no vendor row, no dated headline, and no June default"},
		{"FY2025", "Results of Meeting", "2025-10-30", "AGM vote results"},
		{"FY2025", "Results of 2025 Annual General Meeting", "2025-11-20", "AGM vote results"},
		{"FY26", "Notice of FY26 Results Market Briefing", "2026-08-01", "any Notice of"},
		{"FY26", "AMX to present FY26 Results at Coffee Microcaps Webinar", "2026-08-25", "to present"},
		{"H1 FY26", "Neuren H1 2026 Financial Results Webinar on 26 August 2026", "2026-08-20", "webinar"},
		{"FY26", "Dividend/Distribution - AMA", "2026-08-20", "dividend admin"},
		{"Q1 FY26", "Quarterly Activities Report", "2025-10-28", "quarterly activities report"},
		{"September 2025 quarter", "Quarterly Activities/Appendix 4C Cash Flow Report", "2025-10-30", "4C quarterly"},
		{"H1 FY26", "Quarterly Activity Report and Appendix 4C", "2026-01-29", "quarterly even with a half label"},
		{"1Q26", "1Q26 4C Results - Investor Presentation", "2026-04-28", "a quarter's 4C"},
		{"FY26", "March 2026 Activities Report", "2026-04-20", "activities report"},
		// period traps
		{"Q3 FY25", "Investor Update", "2025-04-20", "a quarter"},
		{"nine months ended 31 March 2025", "Investor Update", "2025-04-20", "nine months"},
		{"FY2026 guidance", "Appendix 4E", "2025-08-20", "guidance"},
		{"FY2026", "Appendix 4E", "2025-08-20", "ends after the report: a forecast"},
		{"H1 FY2023", "Appendix 4D", "2025-02-20", "more than 15 months before the report: a comparative"},
		{"pcp", "Appendix 4D", "2025-02-20", "a comparative"},
		{"H1 FY2024 (prior corresponding period)", "Appendix 4D", "2025-02-20", "a comparative"},
		{"H1", "Investor Presentation", "", "no year and no report date"},
		{"period ended 31 December 2025", "Investor Presentation", "2026-02-20", "no type anywhere"},
		{"FY27E", "Appendix 4E", "2026-08-20", "forecast label"},
		{"", "Investor Presentation", "2026-02-20", "no period anywhere"},
	}
	for _, c := range cases {
		fye := time.June
		if c.why == "no balance date: no vendor row, no dated headline, and no June default" {
			fye = 0
		}
		got, reason, ok := resolveForTest(c.period, c.headline, c.reportDate, fye)
		assert.False(t, ok, "%q / %q resolved to %s %s, want rejected: %s", c.period, c.headline, got.Type, got.End.Format("2006-01-02"), c.why)
		if !ok {
			assert.NotEmpty(t, reason)
		}
	}
}

func TestCanonicalMonthEnd(t *testing.T) {
	for in, want := range map[string]string{
		"2023-07-02": "2023-06-30", // 52/53-week June year ending Sunday 2 July
		"2025-06-28": "2025-06-30",
		"2025-06-30": "2025-06-30",
		"2026-01-03": "2025-12-31", // 52/53-week December year
		"2024-12-29": "2024-12-31",
		"2025-03-31": "2025-03-31",
	} {
		assert.Equal(t, want, canonicalMonthEnd(date(in)).Format("2006-01-02"), in)
	}
}

func TestPeriodEndForFY(t *testing.T) {
	assert.Equal(t, "2025-12-31", periodEndForFY(2026, time.June, periodHalf, false).Format("2006-01-02"))
	assert.Equal(t, "2026-06-30", periodEndForFY(2026, time.June, periodHalf, true).Format("2006-01-02"))
	assert.Equal(t, "2026-06-30", periodEndForFY(2026, time.June, periodAnnual, false).Format("2006-01-02"))
	assert.Equal(t, "2026-06-30", periodEndForFY(2026, time.December, periodHalf, false).Format("2006-01-02"))
	assert.Equal(t, "2025-09-30", periodEndForFY(2026, time.March, periodHalf, false).Format("2006-01-02"), "a March year's H1 ends in September")
}

func TestAddMonths(t *testing.T) {
	assert.Equal(t, time.June, addMonths(time.December, 6))
	assert.Equal(t, time.December, addMonths(time.June, 6))
	assert.Equal(t, time.January, addMonths(time.December, 1))
	assert.Equal(t, time.March, addMonths(time.September, 6))
}

// The June default is gone (plan §4.2 gate 6): without a vendor balance date
// or a dated headline, a label cannot be placed, so it is not.
func TestParsePeriodHasNoJuneDefault(t *testing.T) {
	_, reason, ok := parsePeriod("H1 FY2026", periodContext{Headline: "Appendix 4D", ReportDate: date("2026-02-20")})
	assert.False(t, ok)
	assert.Contains(t, reason, "no balance date")
	got, _, ok := parsePeriod("H1 FY2026", periodContext{Headline: "Appendix 4D", ReportDate: date("2026-08-27"), VendorFYE: time.December})
	if assert.True(t, ok) {
		assert.Equal(t, "2026-06-30", got.End.Format("2006-01-02"), "DRO: a December year's first half ends in June")
	}
	// The vendor's balance month beats a dated headline now (the vendor rows
	// are the contract's source of the balance date).
	got, _, ok = parsePeriod("FY2025", periodContext{Headline: "Appendix 4E for the year ended 30 June 2025", ReportDate: date("2026-02-24"), VendorFYE: time.December})
	if assert.True(t, ok) {
		assert.Equal(t, "2025-12-31", got.End.Format("2006-01-02"))
	}
}

func TestDocumentPeriod(t *testing.T) {
	meta := func(end, typ string) extractiontrust.DocumentMeta {
		return extractiontrust.DocumentMeta{PeriodEnd: end, PeriodType: typ}
	}
	cases := []struct {
		meta       extractiontrust.DocumentMeta
		headline   string
		reportDate string
		fye        time.Month
		wantType   string
		wantEnd    string
		why        string
	}{
		{extractiontrust.DocumentMeta{}, "Appendix 4D - Half Year Report", "2026-02-20", time.June, periodHalf, "2025-12-31", "the latest end before a February report is the half"},
		{extractiontrust.DocumentMeta{}, "Appendix 4E", "2025-08-20", time.June, periodAnnual, "2025-06-30", "an August 4E is the year"},
		{extractiontrust.DocumentMeta{}, "Annual Report 2025", "2025-10-15", time.June, periodAnnual, "2025-06-30", "an annual report four months later"},
		{extractiontrust.DocumentMeta{}, "Appendix 4E - Preliminary Final Report", "2026-02-24", time.December, periodAnnual, "2025-12-31", "DRO: a December year end"},
		{extractiontrust.DocumentMeta{}, "Half Yearly Report and Accounts", "2025-08-27", time.December, periodHalf, "2025-06-30", "DRO's half-year in August"},
		{extractiontrust.DocumentMeta{}, "FY26 Results Release", "2026-08-19", time.June, periodAnnual, "2026-06-30", "headline type"},
		{meta("2026-06-28", "annual"), "Appendix 4E", "2026-08-25", time.June, periodAnnual, "2026-06-30", "document_meta.period_end, a 52/53-week date folded"},
		{meta("2025-12-31", "half"), "Profit Announcement", "2026-02-11", time.June, periodHalf, "2025-12-31", "document_meta period_type"},
		{meta("2025-12-31", ""), "Results for announcement to the market", "2026-02-11", time.June, periodHalf, "2025-12-31", "no type anywhere: the non-balance month is a half"},
	}
	for _, c := range cases {
		got, reason, ok := documentPeriod(c.meta, c.headline, date(c.reportDate), c.fye)
		if assert.True(t, ok, "%s rejected (%s): %s", c.headline, reason, c.why) {
			assert.Equal(t, c.wantType, got.Type, c.why)
			assert.Equal(t, c.wantEnd, got.End.Format("2006-01-02"), c.why)
		}
	}
	_, _, ok := documentPeriod(extractiontrust.DocumentMeta{}, "Appendix 4D", time.Time{}, time.June)
	assert.False(t, ok, "no document period and no report date")
	_, _, ok = documentPeriod(extractiontrust.DocumentMeta{}, "Appendix 4D", date("2026-02-20"), 0)
	assert.False(t, ok, "no balance date")
	// A half-year document whose latest end is the year end: the types
	// disagree, so no metric can match (a late half-year report is withheld).
	got, _, ok := documentPeriod(extractiontrust.DocumentMeta{}, "Appendix 4D", date("2026-07-20"), time.June)
	if assert.True(t, ok) {
		assert.Equal(t, periodHalf, got.Type)
		assert.Equal(t, "2026-06-30", got.End.Format("2006-01-02"))
	}
}

// Gate 4 on the quote itself: a comparative labelled as the current period
// (CBA) names only another period.
func TestQuoteNamesOnlyOtherPeriods(t *testing.T) {
	own := resolvedPeriod{Type: periodHalf, End: date("2025-12-31")}
	cases := []struct {
		text string
		want bool
		why  string
	}{
		{"Statutory NPAT for the half year ended 31 December 2024 was $4,748 million", true, "names only the prior half"},
		{"1H25 statutory NPAT $4,748m", true, "a prior-half label"},
		{"Statutory NPAT for the half year ended 31 December 2025 was $5,142 million", false, "names its own period"},
		{"Statutory NPAT of $5,142 million, up 6% on the half year ended 31 December 2024", false, "the prior half is a comparison reference"},
		{"Revenue $3.9bn (1H25: $3.6bn)", false, "a parenthesised comparative is not a claim"},
		{"Revenue $3.9bn compared with 1H25", false, "compared with"},
		{"Revenue of $3.9bn for 1H26, on track for FY26 guidance", false, "own period named alongside the year"},
		{"Revenue from ordinary activities up 12% to $45.2 million", false, "no period named"},
		{"Interim dividend payable on 26 March 2026", false, "a payment date is not a period"},
	}
	for _, c := range cases {
		assert.Equal(t, c.want, quoteNamesOnlyOtherPeriods(c.text, own, time.June), "%q: %s", c.text, c.why)
	}
}
