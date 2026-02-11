package shorts

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

// GetStockFinancialHighlights retrieves extracted financial metrics for given stock codes
func (s *ShortsServer) GetStockFinancialHighlights(ctx context.Context, req *connect.Request[shortsv1alpha1.GetStockFinancialHighlightsRequest]) (*connect.Response[shortsv1alpha1.GetStockFinancialHighlightsResponse], error) {
	codes := req.Msg.StockCodes
	if len(codes) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("stock_codes is required"))
	}
	if len(codes) > 50 {
		codes = codes[:50]
	}

	maxPerStock := int(req.Msg.MaxReportsPerStock)
	if maxPerStock <= 0 {
		maxPerStock = 2
	}

	highlights, err := s.store.GetStockFinancialHighlights(codes, maxPerStock)
	if err != nil {
		s.logger.Errorf("failed to get financial highlights: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get financial highlights"))
	}

	response := &shortsv1alpha1.GetStockFinancialHighlightsResponse{
		Highlights: make(map[string]*shortsv1alpha1.StockFinancialHighlights),
	}

	for code, reports := range highlights {
		var protoReports []*shortsv1alpha1.FinancialReportHighlight
		for _, r := range reports {
			var protoMetrics []*shortsv1alpha1.FinancialMetric
			for _, m := range r.Metrics {
				protoMetrics = append(protoMetrics, &shortsv1alpha1.FinancialMetric{
					MetricType: m.MetricType,
					SourceText: m.SourceText,
					Attributes: m.Attributes,
				})
			}
			protoReports = append(protoReports, &shortsv1alpha1.FinancialReportHighlight{
				ReportTitle: r.ReportTitle,
				ReportType:  r.ReportType,
				ReportDate:  r.ReportDate,
				Metrics:     protoMetrics,
			})
		}
		response.Highlights[code] = &shortsv1alpha1.StockFinancialHighlights{
			Reports: protoReports,
		}
	}

	return connect.NewResponse(response), nil
}
