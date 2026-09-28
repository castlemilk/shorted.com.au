package shorts

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/pkg/extractiontrust"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

func filingCandidate(title, reportDate string, confidence float64, meta extractiontrust.DocumentMeta) shortsstore.FilingCandidateRow {
	return shortsstore.FilingCandidateRow{
		ReportURL: "https://www.asx.com.au/" + reportDate + ".pdf", Title: title, ReportDate: dayPtr(reportDate),
		Digest: "Summary of " + title, DigestConfidence: f64(confidence), DocumentMeta: meta,
	}
}

func juneFiler(newestFlow string, cands ...shortsstore.FilingCandidateRow) *shortsstore.LatestFilingInputs {
	return &shortsstore.LatestFilingInputs{
		NewestFlowPeriodEnd: dayPtr(newestFlow), LatestAnnualPeriodEnd: dayPtr("2026-06-30"),
		CompanyName: "BHP GROUP LIMITED", Candidates: cands,
	}
}

func TestSelectLatestFiling(t *testing.T) {
	none := extractiontrust.DocumentMeta{}

	t.Run("the newest results document for the newest flow period", func(t *testing.T) {
		got := selectLatestFiling(juneFiler("2026-06-30",
			filingCandidate("Investor Presentation", "2026-08-20", 0.9, none),         // not a results document
			filingCandidate("Appendix 4E and Annual Report", "2026-08-19", 0.8, none), // the one
			filingCandidate("Half Year Results", "2026-02-18", 0.9, none),             // older period
		))
		require.NotNil(t, got)
		assert.Equal(t, "Appendix 4E and Annual Report", got.ReportTitle)
		assert.Equal(t, "2026-06-30", got.PeriodEnd)
		assert.Equal(t, "annual", got.PeriodType, "resolved on the June balance date")
	})
	t.Run("a half-year document resolves to the half", func(t *testing.T) {
		got := selectLatestFiling(juneFiler("2025-12-31", filingCandidate("Appendix 4D Half Year Report", "2026-02-18", 0.7, none)))
		require.NotNil(t, got)
		assert.Equal(t, "2025-12-31", got.PeriodEnd)
		assert.Equal(t, "half", got.PeriodType)
	})
	t.Run("a document for a different period is not the latest filing", func(t *testing.T) {
		assert.Nil(t, selectLatestFiling(juneFiler("2026-06-30", filingCandidate("Half Year Results", "2026-02-18", 0.9, none))))
	})
	t.Run("low confidence or no digest", func(t *testing.T) {
		assert.Nil(t, selectLatestFiling(juneFiler("2026-06-30", filingCandidate("Appendix 4E", "2026-08-19", 0.59, none))))
		c := filingCandidate("Appendix 4E", "2026-08-19", 0.9, none)
		c.Digest = "  "
		assert.Nil(t, selectLatestFiling(juneFiler("2026-06-30", c)))
		c = filingCandidate("Appendix 4E", "2026-08-19", 0.9, none)
		c.DigestConfidence = nil
		assert.Nil(t, selectLatestFiling(juneFiler("2026-06-30", c)))
	})
	t.Run("document_meta.period_end wins over the report-date resolver", func(t *testing.T) {
		// DRO: a December balance date; its annual report lodged in February.
		dro := &shortsstore.LatestFilingInputs{
			NewestFlowPeriodEnd: dayPtr("2025-12-31"), LatestAnnualPeriodEnd: dayPtr("2025-12-31"), CompanyName: "DRONESHIELD LIMITED",
			Candidates: []shortsstore.FilingCandidateRow{filingCandidate("Appendix 4E and Annual Report", "2026-02-24", 0.8,
				extractiontrust.DocumentMeta{PeriodEnd: "2025-12-31", PeriodType: "annual", Entity: "DroneShield Limited", ReportKind: "appendix_4e"})},
		}
		got := selectLatestFiling(dro)
		require.NotNil(t, got)
		assert.Equal(t, "2025-12-31", got.PeriodEnd)
		assert.Equal(t, "annual", got.PeriodType)
	})
	t.Run("another company's document is withheld", func(t *testing.T) {
		// LFT's extraction carried Winsome's report.
		lft := &shortsstore.LatestFilingInputs{
			NewestFlowPeriodEnd: dayPtr("2026-06-30"), LatestAnnualPeriodEnd: dayPtr("2026-06-30"), CompanyName: "LINDIAN RESOURCES LIMITED",
			Candidates: []shortsstore.FilingCandidateRow{filingCandidate("Annual Report", "2026-09-10", 0.9,
				extractiontrust.DocumentMeta{Entity: "Winsome Resources Limited"})},
		}
		assert.Nil(t, selectLatestFiling(lft))
		lft.Candidates[0].DocumentMeta.Entity = "Lindian Resources Ltd"
		assert.NotNil(t, selectLatestFiling(lft), "the company's own entity passes")
	})
	t.Run("report_kind other vetoes", func(t *testing.T) {
		assert.Nil(t, selectLatestFiling(juneFiler("2026-06-30", filingCandidate("Appendix 4E", "2026-08-19", 0.9,
			extractiontrust.DocumentMeta{ReportKind: "other"}))))
	})
	t.Run("no balance date and no meta cannot be placed", func(t *testing.T) {
		in := juneFiler("2026-06-30", filingCandidate("Appendix 4E", "2026-08-19", 0.9, none))
		in.LatestAnnualPeriodEnd = nil
		assert.Nil(t, selectLatestFiling(in))
	})
	t.Run("a report more than 5 months after the period is not its own", func(t *testing.T) {
		// Reported 2026-01-20: the latest June end is 2025-06-30 (7 months),
		// the latest December end 2025-12-31, which is the flow period here.
		assert.NotNil(t, selectLatestFiling(juneFiler("2025-12-31", filingCandidate("Half Year Results", "2026-01-20", 0.9, none))))
		// An annual report lodged in January resolves to the half just ended,
		// not the June year, so it is not the June year's summary.
		assert.Nil(t, selectLatestFiling(juneFiler("2026-06-30", filingCandidate("Annual Report", "2027-01-10", 0.9, none))))
	})
	t.Run("nothing to describe", func(t *testing.T) {
		assert.Nil(t, selectLatestFiling(nil))
		assert.Nil(t, selectLatestFiling(&shortsstore.LatestFilingInputs{}))
	})
}

func TestResolveOwnPeriodAndCanonicalMonthEnd(t *testing.T) {
	d := func(s string) time.Time { return spDate(s) }
	// 52/53-week years fold onto the month they belong to.
	assert.Equal(t, d("2023-06-30"), canonicalMonthEnd(d("2023-07-02")))
	assert.Equal(t, d("2023-06-30"), canonicalMonthEnd(d("2023-06-25")))
	assert.Equal(t, d("2026-12-31"), canonicalMonthEnd(d("2026-12-31")))

	end, typ, ok := resolveOwnPeriod(extractiontrust.DocumentMeta{PeriodEnd: "2025-12-31"}, d("2026-02-18"), time.June)
	assert.True(t, ok)
	assert.Equal(t, d("2025-12-31"), end)
	assert.Equal(t, "half", typ, "a December end on a June balance date is the half")

	_, typ, _ = resolveOwnPeriod(extractiontrust.DocumentMeta{PeriodEnd: "2025-09-30"}, d("2026-02-18"), time.June)
	assert.Equal(t, "", typ, "a quarter end is neither the half nor the year")

	end, typ, ok = resolveOwnPeriod(extractiontrust.DocumentMeta{}, d("2026-08-19"), time.December)
	assert.True(t, ok)
	assert.Equal(t, d("2026-06-30"), end)
	assert.Equal(t, "half", typ, "a December filer's June end is its half")
}

func TestEntityMatchesCompany(t *testing.T) {
	cases := []struct {
		entity, company string
		want            bool
	}{
		{"BHP Group Limited", "BHP GROUP LIMITED", true},
		{"Commonwealth Bank of Australia", "COMMONWEALTH BANK OF AUSTRALIA.", true},
		{"Winsome Resources Limited", "LINDIAN RESOURCES LIMITED", false}, // an industry word is not an identity
		{"Winsome Lithium Limited", "LINDIAN RESOURCES LIMITED", false},
		{"Limited", "BHP GROUP LIMITED", true},                                  // nothing to judge: no veto
		{"Energy Resources of Australia Ltd", "ENERGY RESOURCES LIMITED", true}, // only generic words: no veto
		{"National Australia Bank Limited", "NATIONAL AUSTRALIA BANK LIMITED", true},
		{"The a2 Milk Company Limited", "A2 MILK COMPANY LIMITED", true},
		{"Qantas Airways Limited", "", true},
	}
	for _, tc := range cases {
		assert.Equal(t, tc.want, entityMatchesCompany(tc.entity, tc.company), "%q vs %q", tc.entity, tc.company)
	}
}
