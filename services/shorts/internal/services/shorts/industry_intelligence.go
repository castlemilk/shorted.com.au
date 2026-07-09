package shorts

import (
	"context"
	"fmt"
	"strings"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"google.golang.org/protobuf/types/known/timestamppb"
)

const (
	industryIntelligenceMaxIndustryLength = 120
	industryIntelligenceDefaultLimit      = int32(50)
	industryIntelligenceMaxLimit          = int32(200)
)

func (s *ShortsServer) GetIndustryIntelligence(ctx context.Context, req *connect.Request[shortsv1alpha1.GetIndustryIntelligenceRequest]) (*connect.Response[shortsv1alpha1.GetIndustryIntelligenceResponse], error) {
	industry := strings.TrimSpace(req.Msg.Industry)
	if len(industry) > industryIntelligenceMaxIndustryLength {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("industry must be at most %d characters", industryIntelligenceMaxIndustryLength))
	}

	limit := normalizeIndustryIntelligenceLimit(req.Msg.RecordLimit)
	cacheKey := s.cache.GetIndustryIntelligenceKey(industry, limit)

	cachedResponse, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		result, err := s.store.GetIndustryIntelligence(industry, limit)
		if err != nil {
			return nil, err
		}
		return buildIndustryIntelligenceResponse(industry, result), nil
	})
	if err != nil {
		s.logger.Errorf("database error in GetIndustryIntelligence: industry=%s err=%v", industry, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get industry intelligence"))
	}

	return connect.NewResponse(cachedResponse.(*shortsv1alpha1.GetIndustryIntelligenceResponse)), nil
}

func normalizeIndustryIntelligenceLimit(limit int32) int32 {
	if limit <= 0 {
		return industryIntelligenceDefaultLimit
	}
	if limit > industryIntelligenceMaxLimit {
		return industryIntelligenceMaxLimit
	}
	return limit
}

func buildIndustryIntelligenceResponse(industry string, result *shortsstore.IndustryIntelligenceResult) *shortsv1alpha1.GetIndustryIntelligenceResponse {
	if result == nil {
		result = &shortsstore.IndustryIntelligenceResult{}
	}

	sources := make([]*shortsv1alpha1.IndustryIntelligenceSource, 0, len(result.Sources))
	sourceNames := make([]string, 0, len(result.Sources))
	for _, source := range result.Sources {
		sources = append(sources, &shortsv1alpha1.IndustryIntelligenceSource{
			SourceKey:   source.SourceKey,
			DisplayName: source.DisplayName,
			SignalKind:  source.SignalKind,
			Publisher:   source.Publisher,
			SourceUrl:   source.SourceURL,
			Licence:     source.Licence,
			Cadence:     source.Cadence,
		})
		sourceNames = append(sourceNames, source.DisplayName)
	}

	records := make([]*shortsv1alpha1.IndustryIntelligenceRecord, 0, len(result.Records))
	for _, record := range result.Records {
		pb := &shortsv1alpha1.IndustryIntelligenceRecord{
			SourceKey:      record.SourceKey,
			SourceRecordId: record.SourceRecordID,
			SignalKind:     record.SignalKind,
			Industry:       record.Industry,
			StockCode:      record.StockCode,
			EntityAbn:      record.EntityABN,
			MetricKey:      record.MetricKey,
			MetricLabel:    record.MetricLabel,
			Unit:           record.Unit,
			PeriodStart:    formatDatePtr(record.PeriodStart),
			PeriodEnd:      formatDatePtr(record.PeriodEnd),
			AsOf:           formatDate(record.AsOf),
			Title:          record.Title,
			Summary:        record.Summary,
			SourceUrl:      record.SourceURL,
			Confidence:     record.Confidence,
		}
		if record.MetricValue != nil {
			pb.HasMetricValue = true
			pb.MetricValue = *record.MetricValue
		}
		records = append(records, pb)
	}

	timeBuckets := make([]*shortsv1alpha1.IndustryIntelligenceTimeBucket, 0, len(result.TimeBuckets))
	for _, bucket := range result.TimeBuckets {
		timeBuckets = append(timeBuckets, &shortsv1alpha1.IndustryIntelligenceTimeBucket{
			SignalKind:     bucket.SignalKind,
			SourceKey:      bucket.SourceKey,
			MetricKey:      bucket.MetricKey,
			MetricLabel:    bucket.MetricLabel,
			Unit:           bucket.Unit,
			BucketLabel:    formatFinancialYearLabel(bucket.FYEndYear),
			BucketStart:    fmt.Sprintf("%04d-07-01", bucket.FYEndYear-1),
			TotalValue:     bucket.TotalValue,
			RecordCount:    bucket.RecordCount,
			EntityCount:    bucket.EntityCount,
			ZeroValueCount: bucket.ZeroValueCount,
		})
	}

	entityTotals := make([]*shortsv1alpha1.IndustryIntelligenceEntityTotal, 0, len(result.EntityTotals))
	for _, total := range result.EntityTotals {
		entityTotals = append(entityTotals, &shortsv1alpha1.IndustryIntelligenceEntityTotal{
			SignalKind:  total.SignalKind,
			SourceKey:   total.SourceKey,
			MetricKey:   total.MetricKey,
			StockCode:   total.StockCode,
			EntityLabel: total.EntityLabel,
			Unit:        total.Unit,
			TotalValue:  total.TotalValue,
			RecordCount: total.RecordCount,
			LatestAsOf:  formatDate(total.LatestAsOf),
		})
	}

	return &shortsv1alpha1.GetIndustryIntelligenceResponse{
		Industry:          industry,
		Sources:           sources,
		Records:           records,
		SourceAttribution: strings.Join(sourceNames, "; "),
		GeneratedAt:       timestamppb.Now(),
		TimeBuckets:       timeBuckets,
		EntityTotals:      entityTotals,
	}
}

// formatFinancialYearLabel renders an Australian financial year by its ending
// year: 2024 -> "2023-24".
func formatFinancialYearLabel(fyEndYear int) string {
	if fyEndYear <= 0 {
		return ""
	}
	return fmt.Sprintf("%d-%02d", fyEndYear-1, fyEndYear%100)
}

func formatDatePtr(t *time.Time) string {
	if t == nil || t.IsZero() {
		return ""
	}
	return formatDate(*t)
}

func formatDate(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format("2006-01-02")
}
