package shorts

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

var weekSlugRegex = regexp.MustCompile(`^\d{4}(-W\d{2}|-\d{2})?$`)

// GetWeeklyReport retrieves a weekly report with narrative analysis
func (s *ShortsServer) GetWeeklyReport(ctx context.Context, req *connect.Request[shortsv1alpha1.GetWeeklyReportRequest]) (*connect.Response[shortsv1alpha1.GetWeeklyReportResponse], error) {
	weekSlug := req.Msg.WeekSlug
	if weekSlug == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("week_slug is required"))
	}
	if !weekSlugRegex.MatchString(weekSlug) {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid week_slug format, expected YYYY-WNN"))
	}

	s.logger.Debugf("get weekly report: %s", weekSlug)

	report, err := s.store.GetWeeklyReport(weekSlug)
	if err != nil {
		s.logger.Errorf("failed to get weekly report: week_slug=%s, err=%v", weekSlug, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get weekly report"))
	}

	if report == nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("weekly report not found: %s", weekSlug))
	}

	// Build response from DB model
	response := &shortsv1alpha1.GetWeeklyReportResponse{
		WeekSlug:     report.WeekSlug,
		Headline:     report.Headline,
		Summary:      report.Summary,
		ReportDate:   report.ReportDate,
		PreviousDate: report.PreviousDate,
	}

	if report.QualityScore != nil {
		response.QualityScore = *report.QualityScore
	}

	// Parse narrative JSON
	if len(report.Narrative) > 0 {
		var narrative shortsv1alpha1.WeeklyNarrative
		if err := json.Unmarshal(report.Narrative, &narrative); err != nil {
			s.logger.Warnf("failed to parse narrative JSON for %s: %v", weekSlug, err)
		} else {
			response.Narrative = &narrative
		}
	}

	// Parse top_shorted JSON
	if len(report.TopShorted) > 0 {
		var topShorted []*shortsv1alpha1.WeeklyReportStock
		if err := json.Unmarshal(report.TopShorted, &topShorted); err != nil {
			s.logger.Warnf("failed to parse top_shorted JSON for %s: %v", weekSlug, err)
		} else {
			response.TopShorted = topShorted
		}
	}

	// Parse risers JSON
	if len(report.Risers) > 0 {
		var risers []*shortsv1alpha1.WeeklyReportMover
		if err := json.Unmarshal(report.Risers, &risers); err != nil {
			s.logger.Warnf("failed to parse risers JSON for %s: %v", weekSlug, err)
		} else {
			response.Risers = risers
		}
	}

	// Parse fallers JSON
	if len(report.Fallers) > 0 {
		var fallers []*shortsv1alpha1.WeeklyReportMover
		if err := json.Unmarshal(report.Fallers, &fallers); err != nil {
			s.logger.Warnf("failed to parse fallers JSON for %s: %v", weekSlug, err)
		} else {
			response.Fallers = fallers
		}
	}

	// Parse FAQs JSON
	if len(report.FAQs) > 0 {
		var faqs []*shortsv1alpha1.WeeklyReportFAQ
		if err := json.Unmarshal(report.FAQs, &faqs); err != nil {
			s.logger.Warnf("failed to parse FAQs JSON for %s: %v", weekSlug, err)
		} else {
			response.Faqs = faqs
		}
	}

	// Parse industry_breakdown JSON
	if len(report.IndustryBreakdown) > 0 {
		var industryBreakdown []*shortsv1alpha1.WeeklyIndustryStat
		if err := json.Unmarshal(report.IndustryBreakdown, &industryBreakdown); err != nil {
			s.logger.Warnf("failed to parse industry_breakdown JSON for %s: %v", weekSlug, err)
		} else {
			response.IndustryBreakdown = industryBreakdown
		}
	}

	// Parse market_stats JSON
	if len(report.MarketStats) > 0 {
		var stats shortsv1alpha1.WeeklyMarketStats
		if err := json.Unmarshal(report.MarketStats, &stats); err != nil {
			s.logger.Warnf("failed to parse market_stats JSON for %s: %v", weekSlug, err)
		} else {
			response.MarketStats = &stats
		}
	}

	// Parse citations JSON
	if len(report.Citations) > 0 {
		var citations []*shortsv1alpha1.WeeklyReportCitation
		if err := json.Unmarshal(report.Citations, &citations); err != nil {
			s.logger.Warnf("failed to parse citations JSON for %s: %v", weekSlug, err)
		} else {
			response.Citations = citations
		}
	}

	// Parse trend_insights JSON
	if len(report.TrendInsights) > 0 {
		var insights []*shortsv1alpha1.WeeklyReportTrendInsight
		if err := json.Unmarshal(report.TrendInsights, &insights); err != nil {
			// TrendInsights may be stored as a map — try map parse
			var insightMap map[string]*shortsv1alpha1.WeeklyReportTrendInsight
			if mapErr := json.Unmarshal(report.TrendInsights, &insightMap); mapErr != nil {
				s.logger.Warnf("failed to parse trend_insights JSON for %s: %v", weekSlug, err)
			} else {
				for _, v := range insightMap {
					insights = append(insights, v)
				}
				response.TrendInsights = insights
			}
		} else {
			response.TrendInsights = insights
		}
	}

	// Hydrate logos + missing industries at read time (never stored in JSONB).
	// Branding failure is non-fatal: the report is returned without logos.
	s.hydrateWeeklyReportBranding(weekSlug, response)

	return connect.NewResponse(response), nil
}

// hydrateWeeklyReportBranding sets logo_url on every stock/mover in the
// response and backfills industry where the stored snapshot left it empty,
// using a single company-metadata lookup across all codes.
func (s *ShortsServer) hydrateWeeklyReportBranding(weekSlug string, response *shortsv1alpha1.GetWeeklyReportResponse) {
	codeSet := make(map[string]struct{})
	for _, stock := range response.TopShorted {
		if stock.Code != "" {
			codeSet[stock.Code] = struct{}{}
		}
	}
	for _, mover := range append(append([]*shortsv1alpha1.WeeklyReportMover{}, response.Risers...), response.Fallers...) {
		if mover.Code != "" {
			codeSet[mover.Code] = struct{}{}
		}
	}
	if len(codeSet) == 0 {
		return
	}

	codes := make([]string, 0, len(codeSet))
	for code := range codeSet {
		codes = append(codes, code)
	}

	branding, err := s.store.GetCompanyBranding(codes)
	if err != nil {
		s.logger.Warnf("failed to hydrate branding for weekly report %s: %v", weekSlug, err)
		return
	}

	for _, stock := range response.TopShorted {
		b := branding[stock.Code]
		stock.LogoUrl = b.LogoURL
		if stock.Industry == "" {
			stock.Industry = b.Industry
		}
	}
	for _, mover := range append(append([]*shortsv1alpha1.WeeklyReportMover{}, response.Risers...), response.Fallers...) {
		b := branding[mover.Code]
		mover.LogoUrl = b.LogoURL
		if mover.Industry == "" {
			mover.Industry = b.Industry
		}
	}
}
