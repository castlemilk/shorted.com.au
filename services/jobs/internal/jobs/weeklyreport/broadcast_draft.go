package weeklyreport

import (
	"context"
	"fmt"
	"html"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// insertReportBroadcastDraft creates a draft broadcast row for a published report.
// kind must be "weekly_report" or "monthly_report" — yearly reports are not broadcast.
// slug is the report slug (source_ref). Idempotent via the unique (type, source_ref) index.
func insertReportBroadcastDraft(ctx context.Context, db *pgxpool.Pool, kind, slug, headline, summary string) error {
	path := "/reports/weekly/" + slug
	if kind == "monthly_report" {
		path = "/reports/monthly/" + slug
	}
	url := "https://shorted.com.au" + path
	subject := headline
	if subject == "" {
		subject = "Shorted report: " + slug
	}
	htmlBody := fmt.Sprintf(`<p>%s</p><p><a href="%s">Read the full report →</a></p>`, html.EscapeString(summary), html.EscapeString(url))
	text := fmt.Sprintf("%s\n\nRead the full report: %s", summary, url)
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_, err := db.Exec(cctx, `
		INSERT INTO broadcasts (type, subject, html_body, text_body, source_ref)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (type, source_ref) WHERE source_ref IS NOT NULL DO NOTHING`,
		kind, subject, htmlBody, text, slug)
	return err
}
