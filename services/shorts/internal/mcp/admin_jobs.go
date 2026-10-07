package mcp

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/jobmonitor"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// AdminReader is read-only. All methods are reached only after the admin
// audience, current administrator and per-call jobs:read checks.
type AdminReader interface {
	AsyncJobs(context.Context) (*AsyncJobsOutput, error)
	ListJobExecutions(context.Context, string, string, int, string) (*jobmonitor.ExecutionPage, error)
	GetJobExecution(context.Context, string, string, string) (*jobmonitor.ExecutionSummary, error)
	EnrichmentJobs(context.Context, EnrichmentJobsInput) (*EnrichmentJobsOutput, error)
}

type AsyncJobsOutput struct {
	Jobs       []jobmonitor.JobStatus `json:"jobs"`
	ObservedAt string                 `json:"observedAt"`
	Stale      bool                   `json:"stale"`
	Incomplete bool                   `json:"incomplete"`
	Warnings   []string               `json:"warnings"`
	// Explicit source coverage prevents an empty or partial response implying
	// that every scheduler, rig and database queue is healthy.
	Sources []JobSource `json:"sources"`
}
type JobSource struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Detail string `json:"detail"`
}

type JobsInput struct {
	Query  string `json:"query,omitempty" jsonschema:"Optional job name or category filter."`
	Status string `json:"status,omitempty" jsonschema:"Optional health: running, ok, overdue, warning, critical, unknown."`
}
type JobExecutionsInput struct {
	Job       string `json:"job" jsonschema:"Cloud Run job name from list_async_jobs."`
	Region    string `json:"region,omitempty" jsonschema:"Region from list_async_jobs; required for names deployed in multiple regions."`
	Limit     int    `json:"limit,omitempty" jsonschema:"Page size, 1-100; default 20."`
	PageToken string `json:"page_token,omitempty" jsonschema:"Opaque nextPageToken from the preceding page for this job."`
}
type JobExecutionInput struct {
	Job           string `json:"job"`
	Region        string `json:"region,omitempty"`
	ExecutionName string `json:"execution_name" jsonschema:"Short execution ID, not a URL or full resource path."`
}
type EnrichmentJobsInput struct {
	Status string `json:"status,omitempty" jsonschema:"queued, processing, completed, failed, cancelled; omit for all."`
	Limit  int    `json:"limit,omitempty" jsonschema:"Page size 1-100, default 25."`
	Offset int    `json:"offset,omitempty" jsonschema:"Zero-based page offset."`
}
type EnrichmentJob struct {
	ID          string `json:"id"`
	StockCode   string `json:"stockCode"`
	Status      string `json:"status"`
	Priority    int32  `json:"priority"`
	CreatedAt   string `json:"createdAt,omitempty"`
	StartedAt   string `json:"startedAt,omitempty"`
	CompletedAt string `json:"completedAt,omitempty"`
	Error       string `json:"error,omitempty"`
}
type EnrichmentJobsOutput struct {
	Jobs       []EnrichmentJob `json:"jobs"`
	Total      int32           `json:"total"`
	NextOffset *int            `json:"nextOffset,omitempty"`
}

func adminReadTool[I, O any](name, title, description string, meta sdk.Meta, handler func(context.Context, AdminReader, I) (O, error)) AdminTool {
	t := AdminTool{Name: name, Scope: ScopeJobsRead}
	t.register = func(server *sdk.Server, reader AdminOperator) {
		spec := &sdk.Tool{Name: name, Title: title, Description: description, Meta: meta, Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true, DestructiveHint: boolPtr(false), IdempotentHint: true, OpenWorldHint: boolPtr(false)}}
		if name == "list_async_jobs" {
			spec.Icons = entrypointIcons()
		}
		sdk.AddTool(server, spec, func(ctx context.Context, req *sdk.CallToolRequest, in I) (*sdk.CallToolResult, O, error) {
			var zero O
			if refusal := requireScope(req, ScopeJobsRead); refusal != nil {
				return refusal, zero, nil
			}
			ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
			defer cancel()
			out, err := handler(ctx, reader, in)
			return nil, out, err
		})
	}
	return t
}
func listAsyncJobsTool() AdminTool {
	return adminReadTool("list_async_jobs", "Async jobs", "Read the async job fleet: Cloud Run runs, all scheduler triggers, housing rig health and enrichment queues. Includes running executions, task counts, timing, errors, log links and explicit source coverage. A successful scheduler trigger alone does not prove its downstream work finished. Data may be cached for 60 seconds; inspect stale, incomplete and warnings. Filter status=running for active work.", entrypointMeta(adminAppURI), func(ctx context.Context, r AdminReader, in JobsInput) (*AsyncJobsOutput, error) {
		if len(in.Query) > 200 {
			return nil, fmt.Errorf("query must be at most 200 bytes")
		}
		if in.Status != "" && !strings.Contains("|running|ok|overdue|warning|critical|unknown|", "|"+in.Status+"|") {
			return nil, fmt.Errorf("invalid health status")
		}
		out, err := r.AsyncJobs(ctx)
		if err != nil {
			return nil, err
		}
		// Never mutate a shared collector snapshot while filtering.
		copyOut := *out
		copyOut.Jobs = []jobmonitor.JobStatus{}
		for _, j := range out.Jobs {
			if in.Status == "running" {
				if j.RunningExecution == "" && len(j.RunningExecutions) == 0 && j.LastRunStatus != "running" && j.Health != jobmonitor.HealthRunning {
					continue
				}
			} else if in.Status != "" && string(j.Health) != in.Status {
				continue
			}
			if !strings.Contains(strings.ToLower(j.Name+" "+j.DisplayName+" "+j.Category), strings.ToLower(in.Query)) {
				continue
			}
			copyOut.Jobs = append(copyOut.Jobs, j)
		}
		return &copyOut, nil
	})
}
func listJobExecutionsTool() AdminTool {
	return adminReadTool("list_job_executions", "Job execution history", "Read a page of Cloud Run execution history, including timing, task counts, retries, cancellation, failure messages and log links. Follow nextPageToken until absent for complete history.", nil, func(ctx context.Context, r AdminReader, in JobExecutionsInput) (*jobmonitor.ExecutionPage, error) {
		return r.ListJobExecutions(ctx, in.Job, in.Region, in.Limit, in.PageToken)
	})
}
func getJobExecutionTool() AdminTool {
	return adminReadTool("get_job_execution", "Job execution status", "Read the current status of one Cloud Run execution. Does not use the 60-second execution snapshot cache.", nil, func(ctx context.Context, r AdminReader, in JobExecutionInput) (*jobmonitor.ExecutionSummary, error) {
		return r.GetJobExecution(ctx, in.Job, in.Region, in.ExecutionName)
	})
}
func listEnrichmentJobsTool() AdminTool {
	return adminReadTool("list_enrichment_jobs", "Enrichment queue", "Read paginated enrichment jobs with queued/processing/completed/failed/cancelled state, stock, timestamps and failure reason. Filter processing to inspect work in progress; queued to inspect backlog.", nil, func(ctx context.Context, r AdminReader, in EnrichmentJobsInput) (*EnrichmentJobsOutput, error) {
		return r.EnrichmentJobs(ctx, in)
	})
}
func searchJobMentionsTool() AdminTool {
	return adminReadTool("search_job_mentions", "Find an async job", "Search admin job names for composer mentions. Empty query lists the first 20 jobs. References are resolved under administrator authentication and jobs:read.", mentionMeta(), func(ctx context.Context, r AdminReader, in MentionInput) (MentionOutput, error) {
		out := MentionOutput{Items: []MentionLink{}}
		if len(in.Query) > 200 {
			return out, fmt.Errorf("query must be at most 200 bytes")
		}
		snapshot, err := r.AsyncJobs(ctx)
		if err != nil {
			return out, err
		}
		// An unavailable source must not masquerade as a complete empty search.
		out.Warnings = snapshot.Warnings
		for _, j := range snapshot.Jobs {
			if strings.Contains(strings.ToLower(j.Name+" "+j.DisplayName), strings.ToLower(in.Query)) {
				out.Items = append(out.Items, MentionLink{Type: "resource_link", URI: jobResourceURI(j), Name: j.Name, Title: j.DisplayName + " · " + j.Region, MIMEType: "application/json"})
				if len(out.Items) == 20 {
					break
				}
			}
		}
		return out, nil
	})
}
