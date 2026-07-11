package shorts

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

const (
	defaultReportListLimit = 24
	maxReportListLimit     = 100
)

// slug shape filters per report type. Weekly slugs look like "2026-W06",
// monthly like "2026-01" and yearly like "2026".
var reportSlugPatterns = map[string]string{
	"weekly":  `^\d{4}-W\d{2}$`,
	"monthly": `^\d{4}-\d{2}$`,
	"yearly":  `^\d{4}$`,
}

// ListReports returns published report summaries, most recent first.
// reportType filters by slug shape ("weekly", "monthly", "yearly");
// empty string or "all" returns every published report.
func (s *postgresStore) ListReports(reportType string, limit int) ([]*ReportListRow, error) {
	if limit <= 0 {
		limit = defaultReportListLimit
	}
	if limit > maxReportListLimit {
		limit = maxReportListLimit
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	query := `
		SELECT
			week_slug,
			headline,
			summary,
			report_date::text,
			quality_score,
			market_stats,
			top_shorted
		FROM weekly_reports
		WHERE published_at IS NOT NULL
	`
	args := []interface{}{}
	if pattern, ok := reportSlugPatterns[reportType]; ok {
		query += ` AND week_slug ~ $1`
		args = append(args, pattern)
	}
	query += fmt.Sprintf(` ORDER BY report_date DESC LIMIT $%d`, len(args)+1)
	args = append(args, limit)

	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to list reports: %w", err)
	}
	defer rows.Close()

	var results []*ReportListRow
	for rows.Next() {
		var row ReportListRow
		var qualityScore sql.NullFloat64
		if err := rows.Scan(
			&row.Slug,
			&row.Headline,
			&row.Summary,
			&row.ReportDate,
			&qualityScore,
			&row.MarketStats,
			&row.TopShorted,
		); err != nil {
			return nil, fmt.Errorf("failed to scan report row: %w", err)
		}
		if qualityScore.Valid {
			score := qualityScore.Float64
			row.QualityScore = &score
		}
		results = append(results, &row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate report rows: %w", err)
	}

	return results, nil
}

// GetCompanyBranding returns logo URL + industry for the given stock codes.
// Logo preference: icon GCS asset, then full GCS asset, then raw logo_url.
// Codes with no metadata row are simply absent from the returned map.
func (s *postgresStore) GetCompanyBranding(codes []string) (map[string]CompanyBranding, error) {
	branding := make(map[string]CompanyBranding, len(codes))
	if len(codes) == 0 {
		return branding, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	query := `
		SELECT
			stock_code,
			COALESCE(NULLIF(logo_icon_gcs_url, ''), NULLIF(logo_gcs_url, ''), NULLIF(logo_url, ''), '') AS logo_url,
			COALESCE(industry, '') AS industry
		FROM "company-metadata"
		WHERE stock_code = ANY($1)
	`

	rows, err := s.db.Query(ctx, query, codes)
	if err != nil {
		return nil, fmt.Errorf("failed to query company branding: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var code string
		var b CompanyBranding
		if err := rows.Scan(&code, &b.LogoURL, &b.Industry); err != nil {
			return nil, fmt.Errorf("failed to scan company branding: %w", err)
		}
		branding[code] = b
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate company branding rows: %w", err)
	}

	return branding, nil
}
