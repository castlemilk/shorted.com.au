package review

import (
	"context"
	"fmt"
	"slices"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/extractiontrust"
)

// report is everything the review prints.
type report struct {
	Generated     time.Time
	Days, Limit   int
	AttemptsKnown bool
	Unread        []gapRow
	Empty         []emptyRow
	Unreadable    []extractionRow
	Withheld      []withheldRow
	Outcomes      []outcomeCount
	Failures      []noticeFailure
	Estimates     []estimateRow
}

// emptyRow is an empty extraction and where it stands in the retries.
type emptyRow struct {
	extractionRow
	State string
}

// withheldRow is an extraction and the gates that withhold some or all of it.
type withheldRow struct {
	extractionRow
	Reasons []string
}

// collect reads everything the review prints.
func collect(ctx context.Context, src source, cfg config, now time.Time) (report, error) {
	rep := report{Generated: now, Days: cfg.days, Limit: cfg.limit}
	var meta, versioned bool
	for _, c := range []struct {
		table, column string
		dst           *bool
	}{
		{"financial_report_extractions", "extraction_attempts", &rep.AttemptsKnown},
		{"financial_report_extractions", "document_meta", &meta},
		{"dividend_notice_attempts", "parser_version", &versioned},
	} {
		ok, err := src.ColumnExists(ctx, c.table, c.column)
		if err != nil {
			return report{}, fmt.Errorf("column %s.%s: %w", c.table, c.column, err)
		}
		*c.dst = ok
	}
	since := now.AddDate(0, 0, -cfg.days)

	rows, err := src.Extractions(ctx, since, rep.AttemptsKnown, meta)
	if err != nil {
		return report{}, fmt.Errorf("extractions: %w", err)
	}
	for _, r := range rows {
		switch {
		case isUnreadable(r):
			rep.Unreadable = append(rep.Unreadable, r)
		case isEmpty(r):
			state := emptyState(r.Attempts, r.ExtractedAt, now, rep.AttemptsKnown)
			if !extractiontrust.IsResultsDocument(r.Title, "") {
				// The extractor offers only titles its results classifier
				// accepts (extract.py _parse_financial_reports), so a notice
				// read before the classifier rejected it is never read again.
				state = notResultsTitle
			}
			rep.Empty = append(rep.Empty, emptyRow{r, state})
		default:
			if reasons := withheldReasons(r); len(reasons) > 0 {
				rep.Withheld = append(rep.Withheld, withheldRow{r, reasons})
			}
		}
	}

	companies, err := src.Companies(ctx)
	if err != nil {
		return report{}, fmt.Errorf("companies: %w", err)
	}
	var urls []string
	for _, c := range companies {
		if d, ok := newestResultsDocument(c.FinancialReports); ok {
			urls = append(urls, d.URL)
		}
	}
	states, err := src.ExtractionStates(ctx, urls, rep.AttemptsKnown)
	if err != nil {
		return report{}, fmt.Errorf("extraction states: %w", err)
	}
	rep.Unread = unreadResults(companies, states, now, cfg.days, rep.AttemptsKnown)

	if rep.Outcomes, err = src.NoticeOutcomes(ctx, since, versioned); err != nil {
		return report{}, fmt.Errorf("notice outcomes: %w", err)
	}
	if rep.Failures, err = src.NoticeFailures(ctx, since, versioned); err != nil {
		return report{}, fmt.Errorf("notice failures: %w", err)
	}
	for i := range rep.Failures {
		rep.Failures[i].State = noticeState(rep.Failures[i], now)
	}
	sortFailures(rep.Failures)

	estimates, err := src.ConfirmedEstimates(ctx)
	if err != nil {
		return report{}, fmt.Errorf("confirmed estimates: %w", err)
	}
	var codes []string
	for _, e := range estimates {
		if e.StockCode != "" && !slices.Contains(codes, e.StockCode) {
			codes = append(codes, e.StockCode)
		}
	}
	docs, err := src.EstimateDocuments(ctx, codes, meta)
	if err != nil {
		return report{}, fmt.Errorf("estimate documents: %w", err)
	}
	rep.Estimates = estimateStates(estimates, docs)
	return rep, nil
}
