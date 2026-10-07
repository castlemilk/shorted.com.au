package shorts

import (
	"context"
	"errors"
	"testing"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/jobmonitor"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"go.uber.org/mock/gomock"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func TestAdminMCPKeepsDatabaseJobsWhenCloudUnavailable(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	now := time.Now().UTC()
	store.EXPECT().GetCrawlRunStatuses().Return([]*shortsstore.CrawlRunStatus{{RunType: "delta", Host: "rig", Status: "ok", FinishedAt: &now}}, nil)
	store.EXPECT().GetSyncStatus(shortsstore.SyncStatusFilter{Limit: 20}).Return(nil, errors.New("db unavailable"))
	queued := shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_QUEUED
	processing := shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_PROCESSING
	store.EXPECT().ListEnrichmentJobs(int32(1), int32(0), &queued).Return(nil, int32(42), nil)
	store.EXPECT().ListEnrichmentJobs(int32(1), int32(0), &processing).Return(nil, int32(7), nil)
	src := &adminMCPSource{Collector: jobmonitor.NewCollector(jobmonitor.Config{}), server: &ShortsServer{store: store}}
	out, err := src.AsyncJobs(context.Background())
	if err != nil || !out.Incomplete || !out.Stale || len(out.Jobs) != 2 || len(out.Warnings) < 2 {
		t.Fatalf("%+v %v", out, err)
	}
	queue := out.Jobs[1]
	if queue.RunningCount != 7 || queue.Records[0].Count != 42 || queue.Health != jobmonitor.HealthRunning {
		t.Fatalf("queue %+v", queue)
	}
}
func TestAdminMCPEnrichmentPaginationAndValidation(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	src := &adminMCPSource{server: &ShortsServer{store: store}}
	for _, in := range []mcp.EnrichmentJobsInput{{Limit: 101}, {Offset: -1}, {Status: "unspecified"}, {Status: "nonsense"}} {
		if _, err := src.EnrichmentJobs(context.Background(), in); err == nil {
			t.Fatalf("accepted %+v", in)
		}
	}
	state := shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_FAILED
	stamp := time.Date(2026, 10, 7, 1, 0, 0, 0, time.UTC)
	store.EXPECT().ListEnrichmentJobs(int32(1), int32(0), &state).Return([]*shortsv1alpha1.EnrichmentJob{{JobId: "j1", StockCode: "BHP", Status: state, StartedAt: timestamppb.New(stamp), ErrorMessage: "provider timeout"}}, int32(2), nil)
	out, err := src.EnrichmentJobs(context.Background(), mcp.EnrichmentJobsInput{Status: "failed", Limit: 1})
	if err != nil || out.NextOffset == nil || *out.NextOffset != 1 || out.Total != 2 || out.Jobs[0].Status != "failed" || out.Jobs[0].Error != "provider timeout" || out.Jobs[0].StartedAt != "2026-10-07T01:00:00Z" {
		t.Fatalf("%+v %v", out, err)
	}
}
