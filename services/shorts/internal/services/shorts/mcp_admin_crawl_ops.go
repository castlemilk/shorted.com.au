package shorts

// mcp_admin_crawl_ops.go: the adapters behind the housing crawl debugging and smoke tools
// (internal/mcp/admin_crawl_ops.go, admin_crawl_smoke.go). They give the tools the BrandBrain
// fleet client, the read-only ledger view and the collector's server schedules, and they
// convert the store's row types into the tools' own.

import (
	"context"
	"errors"
	"os"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/brandbrain"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// crawlCollectorScheduleSuffixes are the server schedules of the house-price-collector job:
// the enqueue (delta and full), the finalize, the freshness check and the property resolve.
// The job's monthly and drop-index schedules are not the housing crawl's and are left out.
var crawlCollectorScheduleSuffixes = []string{"-enqueue-delta", "-enqueue-full", "-crawl-finalize", "-freshness", "-property-resolve"}

// brandbrainFleetClientFromEnv returns the fleet client, or nil when BRANDBRAIN_FLEET_OPS_TOKEN
// is unset or the base URL is refused. A refused URL is logged once; the message never
// carries the token.
func brandbrainFleetClientFromEnv() *brandbrain.FleetClient {
	c, err := brandbrain.FleetFromEnv(os.Getenv)
	if err != nil {
		log.Errorf("admin housing crawl: %v; the BrandBrain fleet tools are not configured", err)
		return nil
	}
	return c
}

// CrawlFleet returns the fleet client for one admin, naming the admin's verified address
// to BrandBrain. It is nil (not a typed nil) when the fleet is not configured.
func (a *adminMCPSource) CrawlFleet(ctx context.Context, userID string) mcp.CrawlFleet {
	if a == nil || a.crawlFleet == nil {
		return nil
	}
	operator := ""
	if a.verifiedEmail != nil {
		if email, err := a.verifiedEmail(ctx, userID); err == nil {
			operator = email
		}
	}
	return a.crawlFleet.WithOperator(operator)
}

// CrawlOps returns the read-only ledger view, or nil when the store does not provide it.
func (a *adminMCPSource) CrawlOps() mcp.CrawlOpsStore {
	if a == nil || a.server == nil {
		return nil
	}
	s, ok := a.server.store.(shortsstore.CrawlOpsAdminStore)
	if !ok {
		return nil
	}
	return crawlOpsAdapter{store: s}
}

// CrawlSchedules returns the state and last attempt of the house-price-collector server
// schedules, as the job monitor reports them.
func (a *adminMCPSource) CrawlSchedules(ctx context.Context) ([]mcp.CrawlSchedule, error) {
	if a == nil || a.Collector == nil {
		return nil, errors.New("the job monitor is not wired on this deployment")
	}
	jobs, err := a.Collect(ctx)
	if err != nil {
		return nil, err
	}
	out := []mcp.CrawlSchedule{}
	for _, j := range jobs {
		if j.Name != "house-price-collector" {
			continue
		}
		for _, t := range j.Triggers {
			if !hasAnySuffix(t.Name, crawlCollectorScheduleSuffixes) {
				continue
			}
			out = append(out, mcp.CrawlSchedule{Name: t.Name, ScheduleHuman: t.ScheduleHuman, State: t.State,
				LastAttemptAt: t.LastAttemptAt, LastStatus: t.LastStatus})
		}
	}
	return out, nil
}

func hasAnySuffix(s string, suffixes []string) bool {
	for _, suf := range suffixes {
		if strings.HasSuffix(s, suf) {
			return true
		}
	}
	return false
}

// crawlOpsAdapter converts the store's ledger rows into the tools' types. It adds no logic.
type crawlOpsAdapter struct {
	store shortsstore.CrawlOpsAdminStore
}

func (c crawlOpsAdapter) DispatchOpen(ctx context.Context) (int64, int64, error) {
	return c.store.CrawlDispatchOpen(ctx)
}

func (c crawlOpsAdapter) ReceiptGroups(ctx context.Context, since time.Time, rigSubject string, statuses []string) ([]mcp.CrawlReceiptGroup, error) {
	rows, err := c.store.CrawlReceiptGroups(ctx, since, rigSubject, statuses)
	if err != nil {
		return nil, err
	}
	out := make([]mcp.CrawlReceiptGroup, 0, len(rows))
	for _, r := range rows {
		out = append(out, mcp.CrawlReceiptGroup{Source: r.Source, AppliedStatus: r.AppliedStatus, Suburb: r.Suburb, Count: r.Count})
	}
	return out, nil
}

func (c crawlOpsAdapter) QuarantineReasons(ctx context.Context, since time.Time, rigSubject string) ([]mcp.CrawlReasonCount, error) {
	rows, err := c.store.CrawlQuarantineReasons(ctx, since, rigSubject)
	if err != nil {
		return nil, err
	}
	out := make([]mcp.CrawlReasonCount, 0, len(rows))
	for _, r := range rows {
		out = append(out, mcp.CrawlReasonCount{Reason: r.Reason, Count: r.Count})
	}
	return out, nil
}

func (c crawlOpsAdapter) FinalizeWatermark(ctx context.Context) (time.Time, time.Time, bool, error) {
	return c.store.CrawlFinalizeWatermark(ctx)
}

func (c crawlOpsAdapter) DispatchForRun(ctx context.Context, runID string) ([]mcp.CrawlDispatch, error) {
	rows, err := c.store.CrawlDispatchForRun(ctx, runID)
	if err != nil {
		return nil, err
	}
	out := make([]mcp.CrawlDispatch, 0, len(rows))
	for _, r := range rows {
		out = append(out, dispatchToMCP(r))
	}
	return out, nil
}

func (c crawlOpsAdapter) DispatchForJob(ctx context.Context, jobID string) (*mcp.CrawlDispatch, error) {
	r, err := c.store.CrawlDispatchForJob(ctx, jobID)
	if err != nil || r == nil {
		return nil, err
	}
	d := dispatchToMCP(*r)
	return &d, nil
}

func (c crawlOpsAdapter) ReceiptsForJob(ctx context.Context, jobID string) ([]mcp.CrawlReceipt, error) {
	rows, err := c.store.CrawlReceiptsForJob(ctx, jobID)
	if err != nil {
		return nil, err
	}
	out := make([]mcp.CrawlReceipt, 0, len(rows))
	for _, r := range rows {
		out = append(out, mcp.CrawlReceipt{Key: r.Key, AppliedStatus: r.AppliedStatus, ListingsUpserted: r.ListingsUpserted,
			Events: r.Events, Delisted: r.Delisted, Quarantined: r.Quarantined, Poisoned: r.Poisoned, Replayed: r.Replayed,
			CreatedAt: r.CreatedAt})
	}
	return out, nil
}

func (c crawlOpsAdapter) QuarantineForJob(ctx context.Context, jobID string) ([]mcp.CrawlQuarantine, error) {
	rows, err := c.store.CrawlQuarantineForJob(ctx, jobID)
	if err != nil {
		return nil, err
	}
	out := make([]mcp.CrawlQuarantine, 0, len(rows))
	for _, r := range rows {
		out = append(out, mcp.CrawlQuarantine{Reason: r.Reason, CreatedAt: r.CreatedAt})
	}
	return out, nil
}

func dispatchToMCP(r shortsstore.CrawlDispatchRow) mcp.CrawlDispatch {
	return mcp.CrawlDispatch{JobID: r.JobID, RunID: r.RunID, Selection: r.Selection, Suburb: r.Suburb, State: r.State,
		Postcode: r.Postcode, Source: r.Source, CreatedAt: r.CreatedAt, ExpiresAt: r.ExpiresAt, ClosedAt: r.ClosedAt}
}
