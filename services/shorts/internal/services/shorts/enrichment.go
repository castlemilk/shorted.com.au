package shorts

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

func (s *ShortsServer) EnrichStock(ctx context.Context, req *connect.Request[shortsv1alpha1.EnrichStockRequest]) (*connect.Response[shortsv1alpha1.EnrichStockResponse], error) {
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

	// Check if stock exists
	exists, err := s.store.StockExists(stockCode)
	if err != nil {
		s.logger.Errorf("store error checking stock exists: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to check stock exists"))
	}
	if !exists {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("stock not found: %s", stockCode))
	}

	// Check if there's already an active job for this stock
	activeJob, err := s.store.GetActiveEnrichmentJobByStockCode(stockCode)
	if err != nil {
		s.logger.Errorf("failed to check for active enrichment job for %s: %v", stockCode, err)
		// Continue anyway, it's a safety check
	}
	if activeJob != nil && !req.Msg.Force {
		return connect.NewResponse(&shortsv1alpha1.EnrichStockResponse{
			StockCode: stockCode,
			JobId:     activeJob.JobId,
			Message:   fmt.Sprintf("Enrichment already in progress for %s (Job ID: %s). Use force=true to override.", stockCode, activeJob.JobId),
		}), nil
	}

	// Check if there's already a pending enrichment waiting for review
	if !req.Msg.Force {
		pendingEnrichment, err := s.store.GetPendingEnrichmentByStockCode(stockCode)
		if err != nil {
			s.logger.Errorf("failed to check for pending enrichment for %s: %v", stockCode, err)
			// Continue anyway, it's a safety check
		}
		if pendingEnrichment != nil {
			return connect.NewResponse(&shortsv1alpha1.EnrichStockResponse{
				StockCode: stockCode,
				JobId:     "", // No job created
				Message:   fmt.Sprintf("Pending enrichment already exists for %s (Enrichment ID: %s). Review or reject it first, or use force=true to create a new enrichment.", stockCode, pendingEnrichment.EnrichmentId),
			}), nil
		}
	}

	// Create enrichment job in database
	jobID, err := s.store.CreateEnrichmentJob(stockCode, req.Msg.Force)
	if err != nil {
		s.logger.Errorf("failed to create enrichment job for %s: %v", stockCode, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to create enrichment job"))
	}

	// Publish to Pub/Sub if configured
	if s.pubSubClient != nil {
		err = s.pubSubClient.PublishEnrichmentJob(ctx, jobID, stockCode, req.Msg.Force)
		if err != nil {
			s.logger.Errorf("failed to publish enrichment job to Pub/Sub for %s: %v", stockCode, err)
			// Continue anyway - the job is in the DB and can be processed later
		}
	} else {
		s.logger.Warnf("Pub/Sub client not configured - enrichment job %s created but not queued", jobID)
	}

	return connect.NewResponse(&shortsv1alpha1.EnrichStockResponse{
		StockCode: stockCode,
		JobId:     jobID,
		Message:   fmt.Sprintf("Enrichment job created. Job ID: %s", jobID),
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

func (s *ShortsServer) GetEnrichmentJobStatus(ctx context.Context, req *connect.Request[shortsv1alpha1.GetEnrichmentJobStatusRequest]) (*connect.Response[shortsv1alpha1.GetEnrichmentJobStatusResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("request is required"))
	}

	jobID := req.Msg.JobId
	if jobID == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("job_id is required"))
	}

	job, err := s.store.GetEnrichmentJob(jobID)
	if err != nil {
		s.logger.Errorf("failed to get enrichment job %s: %v", jobID, err)
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("enrichment job not found: %s", jobID))
	}

	return connect.NewResponse(&shortsv1alpha1.GetEnrichmentJobStatusResponse{
		Job: job,
	}), nil
}

func (s *ShortsServer) ListEnrichmentJobs(ctx context.Context, req *connect.Request[shortsv1alpha1.ListEnrichmentJobsRequest]) (*connect.Response[shortsv1alpha1.ListEnrichmentJobsResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("request is required"))
	}

	limit := req.Msg.Limit
	if limit <= 0 {
		limit = 100
	}
	offset := req.Msg.Offset
	if offset < 0 {
		offset = 0
	}

	var status *shortsv1alpha1.EnrichmentJobStatus
	if req.Msg.Status != shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_UNSPECIFIED {
		status = &req.Msg.Status
	}

	jobs, totalCount, err := s.store.ListEnrichmentJobs(limit, offset, status)
	if err != nil {
		s.logger.Errorf("failed to list enrichment jobs: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list enrichment jobs"))
	}

	return connect.NewResponse(&shortsv1alpha1.ListEnrichmentJobsResponse{
		Jobs:       jobs,
		TotalCount: totalCount,
	}), nil
}

