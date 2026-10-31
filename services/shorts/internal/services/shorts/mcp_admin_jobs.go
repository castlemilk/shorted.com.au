package shorts

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/brandbrain"
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
	// people and users back the users:read tools (mcp_admin_people.go). Either
	// may be nil; the tools then name the source as unavailable.
	people shortsstore.PeopleStore
	users  firebaseUsersReader
	// billing backs the billing audit (mcp_admin_billing.go); web reaches the
	// Stripe-facing and probe routes of the web app. Either may be nil.
	billing shortsstore.BillingStore
	web     *adminWebClient
	// probing is set while a paid-feature probe run is in flight through this
	// source. A second run is refused at once, not queued behind the first.
	probing atomic.Bool
	// alerts, alertJobs, entitled, verifiedEmail and logger back the alerts tools
	// (mcp_admin_alerts.go). Nil reads as unavailable, except logger (the adapter's
	// own) and verifiedEmail, whose nil means "no verified address source" and the
	// smoke test refuses.
	alerts        adminAlertsStore
	alertJobs     adminAlertsJobs
	entitled      func(userID string) (bool, error)
	verifiedEmail func(ctx context.Context, userID string) (string, error)
	logger        Logger
	// crawlGrants is the BrandBrain grant client behind housing_crawl_authorize. Nil
	// when BRANDBRAIN_HOUSING_GRANT_TOKEN is unset (mcp_admin_crawl.go).
	crawlGrants mcp.CrawlGrantClient
	// crawlIngest reads the deployed housing-ingest config for the admission signal
	// (mcp_admin_ingest.go). Nil reads as unknown.
	crawlIngest *ingestAdmission
	// crawlFleet is the BrandBrain fleet client behind the crawl debugging and smoke tools
	// (mcp_admin_crawl_ops.go). Nil when BRANDBRAIN_FLEET_OPS_TOKEN is unset.
	crawlFleet *brandbrain.FleetClient
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
	// The jobs moved to the omega cluster read their runs from Telesis; without
	// it they read as paused and overdue, so say which it is.
	switch state, clusterErr := a.ClusterMonitoring(); state {
	case "available":
		out.Sources = append(out.Sources, mcp.JobSource{Name: "telesis_cron_monitors", Status: "available", Detail: "Runs of jobs on the omega Kubernetes cluster (triggers in state CLUSTER), as cronjob-reporter reports them to Telesis."})
	case "degraded":
		out.Incomplete = true
		out.Warnings = append(out.Warnings, "Telesis cron monitors could not be read: "+clusterErr.Error())
		out.Sources = append(out.Sources, mcp.JobSource{Name: "telesis_cron_monitors", Status: "degraded", Detail: "Jobs on the omega cluster fall back to their paused Cloud Scheduler triggers and old Cloud Run runs, so they can read as paused or overdue."})
	default:
		out.Sources = append(out.Sources, mcp.JobSource{Name: "telesis_cron_monitors", Status: "unconfigured", Detail: "TELESIS_API_TOKEN and TELESIS_ORG_ID are unset: jobs on the omega cluster read as paused and overdue from their old Cloud Run history."})
	}
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
