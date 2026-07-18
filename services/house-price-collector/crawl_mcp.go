package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// runMCP is the -mode=mcp entry point: a stdio MCP server exposing the
// brandbrain real-estate crawl queue as tools (status / purge / enqueue) so
// monitoring + cleaning is a single tool call instead of a curl/CLI dance. It
// reuses the SAME brandbrain agent client as -mode agent/enqueue/purge, so auth
// is the local macOS agent's auto-refreshed token (no credential handling here).
// Registered in Claude Code as a stdio MCP server; env: BRANDBRAIN_AGENT_URL
// (DATABASE_URL is required by main() to init a lazy pool but is never used).
func runMCP(ctx context.Context, _ *pgxpool.Pool) {
	acfg := loadAgentConfig()
	if acfg.brandbrainURL == "" {
		log.Fatal("[mcp] BRANDBRAIN_AGENT_URL is required")
	}
	client := newBrandbrainAgentClient(acfg)

	s := server.NewMCPServer("shorted-crawl-queue", "1.0.0",
		server.WithToolCapabilities(false),
		server.WithInstructions("Manage the brandbrain real-estate crawl queue: crawl_status (read), crawl_purge (invalidate stale jobs — dry-run by default), crawl_enqueue (post the suburb catalog)."))

	// crawl_status — whole-queue counts + a source (rea/domain/both) breakdown.
	s.AddTool(mcp.NewTool("crawl_status",
		mcp.WithDescription("Get the real-estate crawl queue status: whole-queue counts (kind→status) plus a source (rea/domain/both) → status breakdown of the recent sample. Read-only."),
		mcp.WithNumber("limit", mcp.Description("How many recent rows to sample for the source breakdown (default 500).")),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		res, err := client.crawlSummary(ctx, req.GetInt("limit", 500))
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("crawl_status: %v", err)), nil
		}
		bySource := map[string]map[string]int{}
		for _, j := range res.Jobs {
			src := j.Source
			if src == "" {
				src = "unknown"
			}
			if bySource[src] == nil {
				bySource[src] = map[string]int{}
			}
			bySource[src][j.Status]++
		}
		b, _ := json.MarshalIndent(map[string]any{
			"by_kind_status":   res.Summary,
			"by_source_status": bySource,
			"recent_sampled":   len(res.Jobs),
		}, "", "  ")
		return mcp.NewToolResultText(string(b)), nil
	})

	// crawl_purge — invalidate stale jobs by criteria (dry-run by default).
	s.AddTool(mcp.NewTool("crawl_purge",
		mcp.WithDescription("Purge (invalidate) crawl-queue jobs by criteria — e.g. clear legacy source='both' jobs after the per-source split. DRY-RUN by default (returns the match count only); set dry_run=false to actually delete. Requires a statuses filter so it can never blanket-delete."),
		mcp.WithString("statuses", mcp.Required(), mcp.Description("Comma-separated statuses to purge, e.g. 'pending,in_progress'. Required.")),
		mcp.WithString("source", mcp.Description("Filter: rea | domain | both. Empty = any.")),
		mcp.WithString("kind", mcp.Description("Filter by kind (e.g. housing). Empty = any.")),
		mcp.WithString("tier", mcp.Description("Filter by tier (e.g. listings). Empty = any.")),
		mcp.WithBoolean("dry_run", mcp.Description("If true (default), only count matches; set false to delete.")),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		statusesStr, err := req.RequireString("statuses")
		if err != nil {
			return mcp.NewToolResultError("statuses is required (e.g. 'pending,in_progress')"), nil
		}
		var statuses []string
		for _, p := range strings.Split(statusesStr, ",") {
			if p = strings.TrimSpace(p); p != "" {
				statuses = append(statuses, p)
			}
		}
		if len(statuses) == 0 {
			return mcp.NewToolResultError("statuses must be non-empty"), nil
		}
		resp, err := client.purge(ctx, crawlPurgeRequest{
			Kind:     req.GetString("kind", ""),
			Source:   req.GetString("source", ""),
			Tier:     req.GetString("tier", ""),
			Statuses: statuses,
			DryRun:   req.GetBool("dry_run", true),
		})
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("crawl_purge: %v", err)), nil
		}
		verb := "would delete (DRY-RUN — set dry_run=false to delete)"
		if !resp.DryRun {
			verb = "DELETED"
		}
		return mcp.NewToolResultText(fmt.Sprintf("%s %d job(s) [source=%q kind=%q tier=%q statuses=%v]",
			verb, resp.Purged, req.GetString("source", ""), req.GetString("kind", ""), req.GetString("tier", ""), statuses)), nil
	})

	// crawl_enqueue — post the curated suburb catalog (per-source by default).
	s.AddTool(mcp.NewTool("crawl_enqueue",
		mcp.WithDescription("Enqueue the curated suburb catalog into the crawl queue. source: 'split' (default → separate rea+domain jobs), 'rea', 'domain', or 'both' (legacy combined). Idempotent (skips existing pending). Chunked to avoid the edge timeout."),
		mcp.WithString("source", mcp.Description("split | rea | domain | both. Default split.")),
		mcp.WithString("tier", mcp.Description("Tier (default listings).")),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		sources := enqueueSources(req.GetString("source", "split"))
		tier := req.GetString("tier", "listings")
		jobs := make([]crawlEnqueueInput, 0, len(crawlTargets)*len(sources))
		for _, t := range crawlTargets {
			for _, src := range sources {
				jobs = append(jobs, crawlEnqueueInput{Kind: "housing", Suburb: t.Display, State: t.State, Postcode: t.Postcode, Source: src, Tier: tier})
			}
		}
		total := 0
		for i := 0; i < len(jobs); i += 40 {
			end := i + 40
			if end > len(jobs) {
				end = len(jobs)
			}
			n, err := client.enqueue(ctx, jobs[i:end])
			if err != nil {
				return mcp.NewToolResultError(fmt.Sprintf("crawl_enqueue (after %d enqueued): %v", total, err)), nil
			}
			total += n
		}
		return mcp.NewToolResultText(fmt.Sprintf("enqueued %d new job(s) of %d targets × sources=%v (tier=%s)", total, len(crawlTargets), sources, tier)), nil
	})

	log.Printf("[mcp] serving crawl-queue MCP over stdio (brandbrain=%s)", acfg.brandbrainURL)
	if err := server.ServeStdio(s); err != nil {
		log.Fatalf("[mcp] stdio server error: %v", err)
	}
}
