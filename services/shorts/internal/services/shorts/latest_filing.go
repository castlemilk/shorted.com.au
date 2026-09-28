package shorts

import (
	"strings"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/extractiontrust"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// The latest filing summary (docs/plans/fundamentals-coverage.md §5.1):
// the newest extraction that
//
//   - is a statutory results document (extractiontrust.IsResultsDocument),
//   - has digest_confidence >= 0.6 and a digest (the store's query),
//   - has no metrics entry quoting the extractor's few-shot example
//     (extractiontrust.IsFewShotText): its digest was written from those
//     metrics, so it may repeat the example's invented figures,
//   - was not lodged by another company: when document_meta names an entity,
//     extractiontrust.EntityMatches accepts it against the company's name,
//     the same rule the filings ingest applies (the LFT document carrying
//     Winsome's report must not summarise LFT; NST must not summarise Star
//     Entertainment), and
//   - reports the SAME period as the stock's newest flow period: its own
//     period is document_meta.period_end when present, else the latest half
//     or annual end on or before the report date on the company's balance
//     date, within 5 months (plan §4.2 gate 4).
//
// Absent otherwise. A summary of some other period, or of a presentation, is
// worse than none: the page labels it "Summary of <title>, <date>" beside the
// latest figures.

const (
	latestFilingMinConfidence = 0.6
	// ownPeriodMaxLagMonths: a results document is lodged within two months
	// of its balance date (4D/4E), the annual report within four.
	ownPeriodMaxLagMonths = 5
)

// selectLatestFiling picks the summary, or nil.
func selectLatestFiling(in *shortsstore.LatestFilingInputs) *shortsv1alpha1.LatestFilingSummary {
	if in == nil || in.NewestFlowPeriodEnd == nil {
		return nil
	}
	target := canonicalMonthEnd(*in.NewestFlowPeriodEnd)
	var fye time.Month
	if in.LatestAnnualPeriodEnd != nil {
		fye = canonicalMonthEnd(*in.LatestAnnualPeriodEnd).Month()
	}
	for _, c := range in.Candidates {
		if c.ReportDate == nil || c.DigestConfidence == nil || *c.DigestConfidence < latestFilingMinConfidence ||
			strings.TrimSpace(c.Digest) == "" || c.FewShotEcho {
			continue
		}
		meta := c.DocumentMeta
		if !extractiontrust.IsResultsDocument(c.Title, meta.ReportKind) {
			continue
		}
		if meta.Entity != "" && !extractiontrust.EntityMatches(meta.Entity, in.CompanyName) {
			continue
		}
		end, periodType, ok := resolveOwnPeriod(meta, *c.ReportDate, fye)
		if !ok || !end.Equal(target) {
			continue
		}
		return &shortsv1alpha1.LatestFilingSummary{
			ReportUrl:        c.ReportURL,
			ReportTitle:      c.Title,
			ReportDate:       c.ReportDate.Format("2006-01-02"),
			PeriodEnd:        end.Format("2006-01-02"),
			PeriodType:       periodType,
			Digest:           c.Digest,
			DigestConfidence: *c.DigestConfidence,
		}
	}
	return nil
}

// resolveOwnPeriod is the document's own period: document_meta.period_end
// when present (period type from the meta, else from the balance date), else
// the latest half or annual end on or before the report date on the
// company's balance date (fye), within 5 months. fye 0 (no annual row to
// place the balance date) resolves only through the meta.
func resolveOwnPeriod(meta extractiontrust.DocumentMeta, reportDate time.Time, fye time.Month) (time.Time, string, bool) {
	if d, ok := meta.PeriodEndDate(); ok {
		end := canonicalMonthEnd(d)
		periodType := meta.PeriodType
		if periodType == "" && fye != 0 {
			switch end.Month() {
			case fye:
				periodType = extractiontrust.PeriodTypeAnnual
			case addMonths(fye, 6):
				periodType = extractiontrust.PeriodTypeHalf
			}
		}
		return end, periodType, true
	}
	if fye == 0 {
		return time.Time{}, "", false
	}
	annual := latestMonthEndOnOrBefore(reportDate, fye)
	half := latestMonthEndOnOrBefore(reportDate, addMonths(fye, 6))
	end, periodType := annual, extractiontrust.PeriodTypeAnnual
	if half.After(annual) {
		end, periodType = half, extractiontrust.PeriodTypeHalf
	}
	if end.IsZero() || monthsBetween(end, reportDate) > ownPeriodMaxLagMonths {
		return time.Time{}, "", false
	}
	return end, periodType, true
}

// latestMonthEndOnOrBefore is the last day of the latest month m that ends on
// or before d.
func latestMonthEndOnOrBefore(d time.Time, m time.Month) time.Time {
	for y := d.Year(); y >= d.Year()-1; y-- {
		end := lastDayOfMonth(y, m)
		if !end.After(d) {
			return end
		}
	}
	return time.Time{}
}

// canonicalMonthEnd folds a period end onto the month end it belongs to, with
// the 52/53-week shift the picks job uses (services/jobs picks
// canonicalMonthEnd): 2 July 2023 and 28 June 2023 are both June 2023.
func canonicalMonthEnd(d time.Time) time.Time {
	eff := d.AddDate(0, 0, -7)
	if d.Day() >= 24 {
		eff = d
	}
	return lastDayOfMonth(eff.Year(), eff.Month())
}

func lastDayOfMonth(year int, m time.Month) time.Time {
	return time.Date(year, m+1, 0, 0, 0, 0, 0, time.UTC)
}

// addMonths is month-of-year arithmetic (wraps December into January).
func addMonths(m time.Month, n int) time.Month {
	return time.Month((int(m)-1+n%12+12)%12 + 1)
}

// monthsBetween is the whole months from a to b (b later), rounded down.
func monthsBetween(a, b time.Time) int {
	n := (b.Year()-a.Year())*12 + int(b.Month()) - int(a.Month())
	if b.Day() < a.Day() && b.Day() < lastDayOfMonth(b.Year(), b.Month()).Day() {
		n--
	}
	return n
}
