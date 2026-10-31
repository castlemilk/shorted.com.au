package jobmonitor

// crawl_smoke.go starts ONE server-side enqueue of the housing crawl for one suburb, for
// the admin smoke loop (mcp/admin_crawl_smoke.go). It follows picks.go and validate.go.
//
//  1. IAM: roles/run.developer (runWithOverrides) is granted on exactly one more job,
//     house-price-collector, for the shorts-api service account (terraform/environments/prod).
//  2. The argv is BUILT HERE. A caller names a run id and an optional catalog suburb slug;
//     both are matched against closed patterns before GCP is touched. The subcommand and
//     flag names are constants of this file, so no caller text becomes an argv element
//     verbatim. The collector checks the slug against its own catalog a second time.
//  3. The job only enqueues: it posts one target to BrandBrain at queue priority and writes
//     its ledger rows under the run id. It sends no drain and writes no run status.
//
// No already-running guard: a smoke run adds one target to the queue and does not race
// the scheduled enqueue for the same rows (its dispatch rows carry its own run id).

import (
	"context"
	"errors"
	"fmt"
	"regexp"
)

// CrawlCollectorJobName is the ONLY job this method can execute, a constant for the same
// reason as PicksJobName: the IAM elevation is scoped to this one job.
const CrawlCollectorJobName = "house-price-collector"

// crawlSmokeMode is the collector's -mode, as the scheduler passes it.
const crawlSmokeMode = "server-enqueue"

var (
	// ErrInvalidCrawlSmoke: the run id or suburb is outside its closed pattern.
	ErrInvalidCrawlSmoke = errors.New("jobmonitor: invalid crawl smoke request")

	// crawlSmokeRunIDPattern matches the ids the admin tool generates: smoke-<UTC>-<8 hex>.
	crawlSmokeRunIDPattern = regexp.MustCompile(`^smoke-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$`)
	// crawlSmokeSuburbPattern matches a catalog slug such as bondi or st-kilda.
	crawlSmokeSuburbPattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
)

// CrawlSmokeRequest asks for one smoke enqueue.
type CrawlSmokeRequest struct {
	// RunID is the ledger run id, smoke-<UTC>-<8 hex>. The caller generates it so it can
	// report it and poll its rows before the job has started.
	RunID string
	// Suburb is a catalog slug. Empty means the collector picks the stalest suburb.
	Suburb string
	// Actor is the admin identity, for the audit log only.
	Actor string
}

// CrawlSmokeRun describes the execution that was created.
type CrawlSmokeRun struct {
	Job           string   `json:"job"`
	Region        string   `json:"region"`
	ExecutionName string   `json:"executionName"`
	RunID         string   `json:"runId"`
	Suburb        string   `json:"suburb,omitempty"`
	Args          []string `json:"args"`
}

// NewCrawlSmokeRunID returns a fresh run id for a smoke run at the given UTC stamp and
// suffix. The caller passes the random suffix (8 lower-case hex digits) so this package
// stays free of entropy.
func NewCrawlSmokeRunID(stamp, suffix string) (string, error) {
	id := "smoke-" + stamp + "-" + suffix
	if !crawlSmokeRunIDPattern.MatchString(id) {
		return "", fmt.Errorf("%w: run id %q", ErrInvalidCrawlSmoke, id)
	}
	return id, nil
}

// crawlSmokeArgs builds the collector's argv. Pure: given a validated run id and suburb it
// can only ever be a server-enqueue with -selection smoke.
func crawlSmokeArgs(runID, suburb string) []string {
	args := []string{"-mode", crawlSmokeMode, "-selection", "smoke", "-run-id", runID}
	if suburb != "" {
		args = append(args, "-suburb", suburb)
	}
	return args
}

// RunCrawlSmoke starts one smoke enqueue on the collector job.
//
// Validation order: run id and suburb (400) before project config (503) before job
// resolution (404/409) before the start.
func (c *Collector) RunCrawlSmoke(ctx context.Context, req CrawlSmokeRequest) (*CrawlSmokeRun, error) {
	if !crawlSmokeRunIDPattern.MatchString(req.RunID) {
		return nil, fmt.Errorf("%w: run id must be smoke-<UTC>-<8 hex>", ErrInvalidCrawlSmoke)
	}
	if req.Suburb != "" && !crawlSmokeSuburbPattern.MatchString(req.Suburb) {
		return nil, fmt.Errorf("%w: suburb must be a catalog slug", ErrInvalidCrawlSmoke)
	}
	target, err := c.resolveNamedTarget(ctx, CrawlCollectorJobName)
	if err != nil {
		return nil, err
	}
	overrider, ok := c.overrideRunner()
	if !ok {
		return nil, ErrOverridesUnsupported
	}
	args := crawlSmokeArgs(req.RunID, req.Suburb)
	execName, err := overrider.RunWithArgs(ctx, c.cfg.ProjectID, target.Region, target.Name, args)
	if err != nil {
		return nil, err
	}
	c.Invalidate()
	return &CrawlSmokeRun{
		Job:           target.Name,
		Region:        target.Region,
		ExecutionName: execName,
		RunID:         req.RunID,
		Suburb:        req.Suburb,
		Args:          args,
	}, nil
}

// CrawlSmokeResult polls one smoke execution. The job has no report artifact: its state
// and log link are the answer. Its ledger rows are read from the database by the caller.
func (c *Collector) CrawlSmokeResult(ctx context.Context, executionName string) (*ExecutionStatus, error) {
	return c.executionStatus(ctx, CrawlCollectorJobName, executionName)
}
