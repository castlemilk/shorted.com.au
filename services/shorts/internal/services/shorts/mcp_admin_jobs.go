package shorts

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/jobmonitor"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// Reuse the same collector and store as the web admin console, without routing
// through an internal-secret HTTP endpoint or bypassing an admin RPC interceptor.
type adminMCPSource struct {
	*jobmonitor.Collector
	server *ShortsServer
}

var _ mcp.AdminOperator = (*adminMCPSource)(nil)

func (a *adminMCPSource) AsyncJobs(ctx context.Context) (*mcp.AsyncJobsOutput, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out := &mcp.AsyncJobsOutput{Jobs: []jobmonitor.JobStatus{}, Warnings: []string{}, Sources: []mcp.JobSource{}}
	// Independent sources run together; each store query has a ten-second
	// bound so an unavailable database does not hold the host indefinitely.
	var jobs []jobmonitor.JobStatus
	var recs []*shortsstore.CrawlRunStatus
	var runs []*shortsv1alpha1.SyncRun
	var err, crawlErr, syncErr error
	states := []shortsv1alpha1.EnrichmentJobStatus{shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_QUEUED, shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_PROCESSING}
	totals := make([]int32, len(states))
	queueErrors := make([]error, len(states))
	var reads sync.WaitGroup
	reads.Add(3 + len(states))
	go func() { defer reads.Done(); jobs, err = a.Collect(ctx) }()
	go func() { defer reads.Done(); recs, crawlErr = a.server.store.GetCrawlRunStatuses() }()
	go func() {
		defer reads.Done()
		runs, syncErr = a.server.store.GetSyncStatus(shortsstore.SyncStatusFilter{Limit: 20})
	}()
	for i, state := range states {
		go func() {
			defer reads.Done()
			_, totals[i], queueErrors[i] = a.server.store.ListEnrichmentJobs(1, 0, &state)
		}()
	}
	reads.Wait()
	out.ObservedAt = a.ObservedAt()
	if err != nil {
		out.Incomplete = true
		out.Stale = true
		out.Warnings = append(out.Warnings, "Cloud Run/Scheduler collection is incomplete or stale: "+err.Error())
		out.Sources = append(out.Sources, mcp.JobSource{Name: "cloud_run_and_scheduler", Status: "degraded", Detail: "Some configured regions or histories could not be read. Cached data may be present."})
	} else {
		out.Sources = append(out.Sources, mcp.JobSource{Name: "cloud_run_and_scheduler", Status: "available", Detail: "Configured Cloud Run regions and Cloud Scheduler region; HTTP trigger success is not downstream completion."})
	}
	out.Jobs = append(out.Jobs, jobs...)
	if crawlErr != nil {
		out.Incomplete = true
		out.Warnings = append(out.Warnings, "Housing crawl health could not be read.")
	}
	crawlState := "available"
	if crawlErr != nil || len(recs) == 0 {
		crawlState = "unknown"
		out.Incomplete = true
		if crawlErr == nil {
			out.Warnings = append(out.Warnings, "No housing crawl health records are available.")
		}
	}
	out.Sources = append(out.Sources, mcp.JobSource{Name: "housing_crawl", Status: crawlState, Detail: "Last self-reported rig health only; not individual crawl queue tasks or a live process inventory."})
	out.Jobs = append(out.Jobs, crawlRunStatusesToJobs(recs, time.Now().UTC())...)
	if syncErr != nil {
		out.Incomplete = true
		out.Warnings = append(out.Warnings, "Short-data sync record counts could not be read.")
	} else {
		out.Jobs = applySyncStatusDetail(out.Jobs, shortsSyncRun(runs), time.Now().UTC())
	}
	syncState := "available"
	if syncErr != nil || shortsSyncRun(runs) == nil {
		syncState = "unknown"
	}
	out.Sources = append(out.Sources, mcp.JobSource{Name: "short_data_sync", Status: syncState, Detail: "Latest attributable sync_status row supplies record counts and detects successful containers that wrote no data."})
	// Count all active enrichment rows, not just the first page, and retain
	// task-level inspection in list_enrichment_jobs.
	queue := jobmonitor.JobStatus{Name: "enrichment-queue", DisplayName: "Company enrichment queue", Category: "Enrichment", Type: "queue", Health: jobmonitor.HealthOK, LastRunStatus: "unknown"}
	queueOK := true
	for i, state := range states {
		total, e := totals[i], queueErrors[i]
		if e != nil {
			queueOK = false
			continue
		}
		label := strings.ToLower(strings.TrimPrefix(state.String(), "ENRICHMENT_JOB_STATUS_"))
		queue.Records = append(queue.Records, jobmonitor.RecordCount{Label: label, Count: int64(total)})
		if label == "processing" && total > 0 {
			queue.Health = jobmonitor.HealthRunning
			queue.RunningCount = int64(total)
			queue.LastRunStatus = "running"
		}
	}
	state := "available"
	if !queueOK {
		state = "unavailable"
		out.Incomplete = true
		queue.Health = jobmonitor.HealthUnknown
		out.Warnings = append(out.Warnings, "Enrichment queue counts could not be read.")
	}
	queue.Message = "Queue totals are not a worker heartbeat; inspect processing timestamps for stuck tasks."
	out.Jobs = append(out.Jobs, queue)
	out.Sources = append(out.Sources, mcp.JobSource{Name: "enrichment_queue", Status: state, Detail: queue.Message})
	return out, nil
}

func (a *adminMCPSource) EnrichmentJobs(_ context.Context, in mcp.EnrichmentJobsInput) (*mcp.EnrichmentJobsOutput, error) {
	if in.Limit == 0 {
		in.Limit = 25
	}
	if in.Limit < 1 || in.Limit > 100 || in.Offset < 0 || in.Offset > 2147483647 {
		return nil, fmt.Errorf("limit must be 1-100 and offset a non-negative int32")
	}
	var status *shortsv1alpha1.EnrichmentJobStatus
	if in.Status != "" {
		n, ok := shortsv1alpha1.EnrichmentJobStatus_value["ENRICHMENT_JOB_STATUS_"+strings.ToUpper(in.Status)]
		if !ok || n == 0 {
			return nil, fmt.Errorf("status must be queued, processing, completed, failed or cancelled")
		}
		v := shortsv1alpha1.EnrichmentJobStatus(n)
		status = &v
	}
	rows, total, err := a.server.store.ListEnrichmentJobs(int32(in.Limit), int32(in.Offset), status)
	if err != nil {
		return nil, fmt.Errorf("could not read enrichment jobs")
	}
	out := &mcp.EnrichmentJobsOutput{Jobs: []mcp.EnrichmentJob{}, Total: total}
	for _, r := range rows {
		if r == nil {
			continue
		}
		out.Jobs = append(out.Jobs, mcp.EnrichmentJob{ID: r.JobId, StockCode: r.StockCode, Status: strings.ToLower(strings.TrimPrefix(r.Status.String(), "ENRICHMENT_JOB_STATUS_")), Priority: r.Priority, CreatedAt: jobTime(r.CreatedAt), StartedAt: jobTime(r.StartedAt), CompletedAt: jobTime(r.CompletedAt), Error: r.ErrorMessage})
	}
	if next := in.Offset + len(rows); next < int(total) && len(rows) > 0 {
		out.NextOffset = &next
	}
	return out, nil
}
func jobTime(t *timestamppb.Timestamp) string {
	if t == nil {
		return ""
	}
	return t.AsTime().UTC().Format(time.RFC3339)
}
