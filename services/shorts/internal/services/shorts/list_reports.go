package shorts

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

const (
	maxReportListTopCodes  = 5
	defaultReportListLimit = 24
	// 500 covers the full weekly archive (~200 reports, +52/yr) so the
	// /reports/weekly index and prev/next navigation can see every report.
	maxReportListLimit = 500
)

var (
	weeklyReportSlugRegex  = regexp.MustCompile(`^\d{4}-W\d{2}$`)
	monthlyReportSlugRegex = regexp.MustCompile(`^\d{4}-\d{2}$`)
	yearlyReportSlugRegex  = regexp.MustCompile(`^\d{4}$`)
)

var validReportTypes = map[string]bool{
	"":        true,
	"all":     true,
	"weekly":  true,
	"monthly": true,
	"yearly":  true,
}

// reportTypeFromSlug derives the report type from the slug shape:
// "2026-W06" -> weekly, "2026-01" -> monthly, "2026" -> yearly.
func reportTypeFromSlug(slug string) string {
	switch {
	case weeklyReportSlugRegex.MatchString(slug):
		return "weekly"
	case monthlyReportSlugRegex.MatchString(slug):
		return "monthly"
	case yearlyReportSlugRegex.MatchString(slug):
		return "yearly"
	default:
		return ""
	}
}

// ListReports lists published short selling reports for archive/index pages,
// most recent first.
func (s *ShortsServer) ListReports(ctx context.Context, req *connect.Request[shortsv1alpha1.ListReportsRequest]) (*connect.Response[shortsv1alpha1.ListReportsResponse], error) {
	reportType := req.Msg.ReportType
	if !validReportTypes[reportType] {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("invalid report_type %q, expected one of \"\", \"all\", \"weekly\", \"monthly\", \"yearly\"", reportType))
	}

	limit := int(req.Msg.Limit)
	if limit <= 0 {
		limit = defaultReportListLimit
	}
	if limit > maxReportListLimit {
		limit = maxReportListLimit
	}

	s.logger.Debugf("list reports: type=%s limit=%d", reportType, limit)

	rows, err := s.store.ListReports(reportType, limit)
	if err != nil {
		s.logger.Errorf("failed to list reports: type=%s, err=%v", reportType, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list reports"))
	}

	response := &shortsv1alpha1.ListReportsResponse{
		Reports: make([]*shortsv1alpha1.ReportListItem, 0, len(rows)),
	}

	codeSet := make(map[string]struct{})
	for _, row := range rows {
		item := &shortsv1alpha1.ReportListItem{
			Slug:       row.Slug,
			ReportType: reportTypeFromSlug(row.Slug),
			Headline:   row.Headline,
			Summary:    row.Summary,
			ReportDate: row.ReportDate,
		}
		if row.QualityScore != nil {
			item.QualityScore = *row.QualityScore
		}

		if len(row.MarketStats) > 0 {
			var stats shortsv1alpha1.WeeklyMarketStats
			if err := json.Unmarshal(row.MarketStats, &stats); err != nil {
				s.logger.Warnf("failed to parse market_stats JSON for report %s: %v", row.Slug, err)
			} else {
				item.MaxShortPct = stats.MaxShortPct
				item.MaxShortCode = stats.MaxShortCode
				item.TotalStocksShorted = stats.TotalStocksShorted
			}
		}

		if len(row.TopShorted) > 0 {
			var topShorted []*shortsv1alpha1.WeeklyReportStock
			if err := json.Unmarshal(row.TopShorted, &topShorted); err != nil {
				s.logger.Warnf("failed to parse top_shorted JSON for report %s: %v", row.Slug, err)
			} else {
				for _, stock := range topShorted {
					if stock.Code == "" {
						continue
					}
					item.TopCodes = append(item.TopCodes, stock.Code)
					codeSet[stock.Code] = struct{}{}
					if len(item.TopCodes) >= maxReportListTopCodes {
						break
					}
				}
			}
		}

		response.Reports = append(response.Reports, item)
	}

	// Hydrate top_logo_urls (parallel to top_codes, "" when unknown) with a
	// single branding lookup across all rows. Failure is non-fatal.
	var branding map[string]shortsstore.CompanyBranding
	if len(codeSet) > 0 {
		codes := make([]string, 0, len(codeSet))
		for code := range codeSet {
			codes = append(codes, code)
		}
		fetched, err := s.store.GetCompanyBranding(codes)
		if err != nil {
			s.logger.Warnf("failed to hydrate branding for report list: %v", err)
		} else {
			branding = fetched
		}
	}

	for _, item := range response.Reports {
		if len(item.TopCodes) == 0 {
			continue
		}
		item.TopLogoUrls = make([]string, len(item.TopCodes))
		for i, code := range item.TopCodes {
			item.TopLogoUrls[i] = branding[code].LogoURL
		}
	}

	return connect.NewResponse(response), nil
}
