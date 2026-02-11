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
		WeekSlug:   report.WeekSlug,
		Headline:   report.Headline,
		Summary:    report.Summary,
		ReportDate: report.ReportDate,
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

	// Parse market_stats JSON
	if len(report.MarketStats) > 0 {
		var stats shortsv1alpha1.WeeklyMarketStats
		if err := json.Unmarshal(report.MarketStats, &stats); err != nil {
			s.logger.Warnf("failed to parse market_stats JSON for %s: %v", weekSlug, err)
		} else {
			response.MarketStats = &stats
		}
	}

	return connect.NewResponse(response), nil
}
