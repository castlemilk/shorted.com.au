package shorts

import (
	"context"
	"fmt"
	"strings"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/google/uuid"
)

func (s *ShortsServer) EnrichStock(ctx context.Context, req *connect.Request[shortsv1alpha1.EnrichStockRequest]) (*connect.Response[shortsv1alpha1.EnrichStockResponse], error) {
	start := time.Now()

	if req == nil || req.Msg == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("request is required"))
	}

	stockCode := NormalizeStockCode(req.Msg.StockCode)
	if stockCode == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("stock_code is required"))
	}
	if !stockCodeRegex.MatchString(stockCode) {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("stock_code must be 3-4 alphanumeric characters (e.g., CBA, ZIP, AX1)"))
	}

	if s.gptClient == nil {
		return nil, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("enrichment is not configured (missing OPENAI_API_KEY)"))
	}
	if s.reportCrawler == nil {
		return nil, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("report crawler is not configured"))
	}

	exists, err := s.store.StockExists(stockCode)
	if err != nil {
		s.logger.Errorf("store error checking stock exists: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to check stock exists"))
	}
	if !exists {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("stock not found: %s", stockCode))
	}

	// Use current StockDetails as baseline context (v1).
	var details *stocksv1alpha1.StockDetails
	details, err = s.store.GetStockDetails(stockCode)
	if err != nil {
		s.logger.Errorf("store error fetching stock details: %v", err)
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("stock details not found: %s", stockCode))
	}

	// Skip if already enriched and not forced.
	if !req.Msg.Force && strings.EqualFold(details.EnrichmentStatus, "completed") {
		return connect.NewResponse(&shortsv1alpha1.EnrichStockResponse{
			StockCode:        stockCode,
			Status:           shortsv1alpha1.EnrichmentStatus_ENRICHMENT_STATUS_COMPLETED,
			ErrorMessage:     "stock already enriched (use force=true to re-enrich)",
			DurationSeconds:  time.Since(start).Seconds(),
		}), nil
	}

	// Bound the enrichment end-to-end time.
	enrichmentTimeout := s.config.EnrichmentTimeout
	if enrichmentTimeout <= 0 {
		enrichmentTimeout = 5 * time.Minute
	}
	enrichCtx, cancel := context.WithTimeout(ctx, enrichmentTimeout)
	defer cancel()

	// Crawl reports from the company website.
	reports, crawlErr := s.reportCrawler.CrawlFinancialReports(enrichCtx, details.Website)
	if crawlErr != nil {
		// Non-fatal; continue without reports.
		s.logger.Warnf("report crawl failed for %s: %v", stockCode, crawlErr)
		reports = nil
	}

	enriched, err := s.gptClient.EnrichCompany(
		enrichCtx,
		stockCode,
		details.CompanyName,
		details.Industry,
		details.Website,
		details.Summary,
		reports,
	)
	if err != nil {
		s.logger.Errorf("gpt enrichment failed for %s: %v", stockCode, err)
		return connect.NewResponse(&shortsv1alpha1.EnrichStockResponse{
			StockCode:       stockCode,
			Status:          shortsv1alpha1.EnrichmentStatus_ENRICHMENT_STATUS_FAILED,
			ErrorMessage:    err.Error(),
			DurationSeconds: time.Since(start).Seconds(),
		}), nil
	}

	quality, err := s.gptClient.EvaluateQuality(enrichCtx, stockCode, enriched)
	if err != nil {
		s.logger.Warnf("quality evaluation failed for %s: %v", stockCode, err)
		quality = &shortsv1alpha1.QualityScore{
			Warnings: []string{"quality evaluation failed: " + err.Error()},
		}
	}

	threshold := s.config.EnrichmentQualityThreshold
	if threshold <= 0 {
		threshold = 0.7
	}
	if quality != nil && quality.OverallScore > 0 && quality.OverallScore < threshold {
		quality.Warnings = append(quality.Warnings, fmt.Sprintf("overall_score %.2f is below threshold %.2f", quality.OverallScore, threshold))
	}

	enrichmentID := uuid.NewString()

	if err := s.store.SavePendingEnrichment(
		enrichmentID,
		stockCode,
		shortsv1alpha1.EnrichmentStatus_ENRICHMENT_STATUS_PENDING_REVIEW,
		enriched,
		quality,
	); err != nil {
		s.logger.Errorf("failed to save pending enrichment for %s: %v", stockCode, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to save pending enrichment"))
	}

	return connect.NewResponse(&shortsv1alpha1.EnrichStockResponse{
		StockCode:       stockCode,
		Status:          shortsv1alpha1.EnrichmentStatus_ENRICHMENT_STATUS_PENDING_REVIEW,
		Data:            enriched,
		QualityScore:    quality,
		DurationSeconds: time.Since(start).Seconds(),
		EnrichmentId:    enrichmentID,
	}), nil
}

func (s *ShortsServer) GetTopStocksForEnrichment(ctx context.Context, req *connect.Request[shortsv1alpha1.GetTopStocksForEnrichmentRequest]) (*connect.Response[shortsv1alpha1.GetTopStocksForEnrichmentResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("request is required"))
	}

	limit := req.Msg.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 10000 {
		limit = 10000
	}

	stocks, err := s.store.GetTopStocksForEnrichment(limit, req.Msg.Priority)
	if err != nil {
		s.logger.Errorf("failed to get top stocks for enrichment: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get enrichment candidates"))
	}

	return connect.NewResponse(&shortsv1alpha1.GetTopStocksForEnrichmentResponse{
		Stocks: stocks,
	}), nil
}

func (s *ShortsServer) ListPendingEnrichments(ctx context.Context, req *connect.Request[shortsv1alpha1.ListPendingEnrichmentsRequest]) (*connect.Response[shortsv1alpha1.ListPendingEnrichmentsResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("request is required"))
	}

	limit := req.Msg.Limit
	offset := req.Msg.Offset
	if limit <= 0 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}
	if offset < 0 {
		offset = 0
	}

	items, err := s.store.ListPendingEnrichments(limit, offset)
	if err != nil {
		s.logger.Errorf("failed to list pending enrichments: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list pending enrichments"))
	}

	return connect.NewResponse(&shortsv1alpha1.ListPendingEnrichmentsResponse{
		Enrichments: items,
	}), nil
}

func (s *ShortsServer) GetPendingEnrichment(ctx context.Context, req *connect.Request[shortsv1alpha1.GetPendingEnrichmentRequest]) (*connect.Response[shortsv1alpha1.GetPendingEnrichmentResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("request is required"))
	}
	enrichmentID := strings.TrimSpace(req.Msg.EnrichmentId)
	if enrichmentID == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("enrichment_id is required"))
	}

	pending, err := s.store.GetPendingEnrichment(enrichmentID)
	if err != nil {
		s.logger.Errorf("failed to get pending enrichment %s: %v", enrichmentID, err)
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("pending enrichment not found: %s", enrichmentID))
	}

	return connect.NewResponse(&shortsv1alpha1.GetPendingEnrichmentResponse{
		Pending: pending,
	}), nil
}

func (s *ShortsServer) ReviewEnrichment(ctx context.Context, req *connect.Request[shortsv1alpha1.ReviewEnrichmentRequest]) (*connect.Response[shortsv1alpha1.ReviewEnrichmentResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("request is required"))
	}

	userClaims, ok := UserFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("user not authenticated"))
	}

	enrichmentID := strings.TrimSpace(req.Msg.EnrichmentId)
	if enrichmentID == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("enrichment_id is required"))
	}

	pending, err := s.store.GetPendingEnrichment(enrichmentID)
	if err != nil {
		s.logger.Errorf("failed to load pending enrichment %s: %v", enrichmentID, err)
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("pending enrichment not found: %s", enrichmentID))
	}

	// Optional safety: if stock_code is provided, require it to match.
	reqStock := NormalizeStockCode(req.Msg.StockCode)
	if reqStock != "" && !strings.EqualFold(reqStock, pending.StockCode) {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("stock_code does not match pending enrichment"))
	}

	reviewNotes := strings.TrimSpace(req.Msg.ReviewNotes)
	reviewer := strings.TrimSpace(userClaims.Email)
	if reviewer == "" {
		reviewer = userClaims.UserID
	}

	if req.Msg.Approve {
		if err := s.store.ApplyEnrichment(pending.StockCode, pending.Data); err != nil {
			s.logger.Errorf("failed to apply enrichment for %s: %v", pending.StockCode, err)
			return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to apply enrichment"))
		}
	}

	if err := s.store.ReviewEnrichment(enrichmentID, req.Msg.Approve, reviewer, reviewNotes); err != nil {
		s.logger.Errorf("failed to update pending enrichment review for %s: %v", enrichmentID, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to record review"))
	}

	msg := "rejected"
	if req.Msg.Approve {
		msg = "approved and applied"
	}

	return connect.NewResponse(&shortsv1alpha1.ReviewEnrichmentResponse{
		StockCode: pending.StockCode,
		Approved:  req.Msg.Approve,
		Message:   msg,
	}), nil
}


