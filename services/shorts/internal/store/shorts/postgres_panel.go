package shorts

import (
	"context"
	"fmt"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/asxcalendar"
)

// PanelRow is one (date, security) observation of the short-position panel.
type PanelRow struct {
	Date                   string
	AvailableFrom          string
	SecurityType           string
	ProductCode            string
	ProductName            string
	ReportedShortPositions float64
	TotalProductInIssue    float64
	PercentShorted         float64
}

// PanelQuery bounds a panel export.
type PanelQuery struct {
	From         string   // YYYY-MM-DD, inclusive. Required.
	To           string   // YYYY-MM-DD, inclusive. Required.
	ProductCodes []string // Optional filter; empty means every security.
	IncludeZero  bool     // Include zero short positions (see GetMarketByDate).

	// OrdinaryOnly restricts the panel to ordinary share lines. A
	// cross-sectional signal ranks instruments against each other, and an ETF
	// or warrant's "percent of shares on issue" is not comparable with an
	// ordinary share's — see security_type on the stock record (issue #563).
	OrdinaryOnly bool

	// AsOf, YYYY-MM-DD, drops observations not yet PUBLISHED as at that date.
	// This is the surface a backtest is actually built on, so it is the one
	// where four days of lookahead does the most damage.
	AsOf string
}

// StreamPanel walks the short-position panel for a date range and hands each
// row to fn.
//
// Building a research panel otherwise cost one request per trading date. A
// decade is ~2,500 dates against an anonymous quota of 500 requests a month, so
// the dataset was reachable only by someone who discovered that
// GetMarketByDate honours limit=1000 and paged a date at a time — a good
// outcome arrived at by accident, and a researcher who missed it concluded the
// API could not support a panel at all.
//
// Rows are streamed rather than accumulated: a decade of the full panel is
// ~2.1M rows, and materialising that in memory to marshal it would cost more
// than serving it. The caller writes each row out as it arrives, so peak
// memory is one row regardless of the window.
func (s *postgresStore) StreamPanel(ctx context.Context, q PanelQuery, fn func(PanelRow) error) error {
	if q.From == "" || q.To == "" {
		return fmt.Errorf("panel export requires both from and to")
	}

	// A zero short position is a real observation; only NULL is missing data.
	shortFilter := ` AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0`
	if q.IncludeZero {
		shortFilter = ` AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" IS NOT NULL`
	}

	query := `
		SELECT "DATE"::date, "PRODUCT_CODE", COALESCE("PRODUCT", ''),
		       "REPORTED_SHORT_POSITIONS", "TOTAL_PRODUCT_IN_ISSUE",
		       "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
		FROM shorts
		WHERE "DATE" >= $1::timestamp AND "DATE" <= $2::timestamp` + shortFilter
	args := []interface{}{q.From + " 00:00:00", q.To + " 23:59:59"}

	if len(q.ProductCodes) > 0 {
		query += ` AND "PRODUCT_CODE" = ANY($3)`
		args = append(args, q.ProductCodes)
	}

	// Ordered by (date, code) so the output is a stable panel a caller can
	// diff, resume from, or load incrementally — and so a repeated export of
	// the same window is byte-identical.
	query += ` ORDER BY "DATE" ASC, "PRODUCT_CODE" ASC`

	var asOf *time.Time
	if q.AsOf != "" {
		parsed, err := time.Parse("2006-01-02", q.AsOf)
		if err != nil {
			return fmt.Errorf("invalid as_of %q: %w", q.AsOf, err)
		}
		asOf = &parsed
	}

	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("failed to query panel: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var date time.Time
		var row PanelRow
		var short, issued, percent *float64
		if err := rows.Scan(&date, &row.ProductCode, &row.ProductName, &short, &issued, &percent); err != nil {
			return fmt.Errorf("failed to scan panel row: %w", err)
		}
		row.Date = date.Format("2006-01-02")
		availableFrom := asxcalendar.AvailableFrom(date)
		if asOf != nil && availableFrom.After(*asOf) {
			continue
		}
		row.AvailableFrom = availableFrom.Format("2006-01-02")
		row.SecurityType = string(ClassifySecurity(row.ProductName, row.ProductCode, row.TotalProductInIssue))
		if q.OrdinaryOnly && row.SecurityType != string(SecurityTypeOrdinary) {
			continue
		}
		if short != nil {
			row.ReportedShortPositions = finiteOrZero(*short)
		}
		if issued != nil {
			row.TotalProductInIssue = finiteOrZero(*issued)
		}
		if percent != nil {
			row.PercentShorted = finiteOrZero(*percent)
		}
		if err := fn(row); err != nil {
			return err
		}
	}
	return rows.Err()
}
