package mcp

import (
	"context"
	"fmt"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// strategy_status is the read-only view of the strategy engine's daily job: which
// phases ran for the newest sessions, which sessions were held and why, how many
// were backfilled, the canonical versions and the snapshot's table sizes. Every
// field is an aggregate or a session's own facts. It carries no user identifier,
// no email address and no subscription, and no tool here writes.

// AdminStrategyOperator is the optional capability the strategy tool needs. The
// admin server's operator provides it when the store has the snapshot view.
type AdminStrategyOperator interface {
	StrategyStatus() StrategyStatusStore
}

// StrategyStatusStore reads the daily job's status.
type StrategyStatusStore interface {
	StrategyStatus(ctx context.Context, sessions int) (StrategyStatusRead, error)
}

// StrategyStatusRead is the store's answer, in the tool's terms.
type StrategyStatusRead struct {
	Sessions      []StrategyPhase
	LateLast30    int64
	LastCompleted string
	Versions      []StrategyVersion
	Tables        []StrategyTable
	Migrated      bool
}

// StrategyPhase is one phase of one session.
type StrategyPhase struct {
	AsOf   string `json:"asOf"`
	Phase  string `json:"phase"`
	Status string `json:"status"`
	Note   string `json:"note,omitempty"`
	Counts string `json:"counts"`
}

// StrategyVersion is one canonical version.
type StrategyVersion struct {
	StrategyID string `json:"strategyId"`
	Label      string `json:"label"`
	Status     string `json:"status"`
	LiveFrom   string `json:"liveFrom,omitempty"`
}

// StrategyTable is one snapshot table's estimated row count and size.
type StrategyTable struct {
	Name      string `json:"name"`
	RowsEst   int64  `json:"rowsEstimate"`
	SizeBytes int64  `json:"sizeBytes"`
}

// StrategyStatusInput selects how many recent sessions to report.
type StrategyStatusInput struct {
	Sessions int `json:"sessions,omitempty" jsonschema:"How many recent sessions to report, newest first. Default 10, at most 30."`
}

// StrategyStatusOutput is the daily job's state.
type StrategyStatusOutput struct {
	ObservedAt    string            `json:"observedAt"`
	Migrated      bool              `json:"migrated" jsonschema:"False when the strategy snapshot tables do not exist yet (migration 000155 not applied)."`
	LastCompleted string            `json:"lastCompletedSession,omitempty" jsonschema:"The newest session whose features, evaluation and events all completed."`
	LateLast30    int64             `json:"lateSessionsLast30Days" jsonschema:"Sessions in the last 30 days the job backfilled after their own day."`
	Sessions      []StrategyPhase   `json:"sessions" jsonschema:"Each phase of the newest sessions, newest session first. A held session has one held features row whose note gives the reason."`
	Versions      []StrategyVersion `json:"versions" jsonschema:"The canonical versions the database records, with status and live_from. Rules hashes are not shown."`
	Tables        []StrategyTable   `json:"tables" jsonschema:"Estimated rows and bytes of each strategy snapshot table."`
}

const strategyStatusMaxSessions = 30

// strategyStatusTool is registered with the admin tools. The scope is jobs:read:
// it observes the job fleet, and starts nothing.
func strategyStatusTool() AdminTool {
	t := AdminTool{Name: "strategy_status", Scope: ScopeJobsRead}
	t.register = func(server *sdk.Server, pub AdminOperator) {
		sdk.AddTool(server, &sdk.Tool{
			Name:        t.Name,
			Title:       "Check the strategy engine's daily snapshot",
			Description: "Report the strategy daily job for the newest sessions: each phase's status, held sessions and their reasons, late (backfilled) sessions, the canonical versions and the snapshot table sizes. Aggregates only; no user or email data.",
			Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: new(false)},
		}, func(ctx context.Context, req *sdk.CallToolRequest, in StrategyStatusInput) (*sdk.CallToolResult, StrategyStatusOutput, error) {
			if denied := requireScope(req, t.Scope); denied != nil {
				return denied, StrategyStatusOutput{}, nil
			}
			op, ok := pub.(AdminStrategyOperator)
			if !ok || op.StrategyStatus() == nil {
				return adminToolError(fmt.Errorf("strategy status is not wired on this deployment")), StrategyStatusOutput{}, nil
			}
			n := in.Sessions
			if n <= 0 {
				n = 10
			}
			if n > strategyStatusMaxSessions {
				n = strategyStatusMaxSessions
			}
			read, err := op.StrategyStatus().StrategyStatus(ctx, n)
			if err != nil {
				return adminToolError(err), StrategyStatusOutput{}, nil
			}
			out := StrategyStatusOutput{
				ObservedAt:    time.Now().UTC().Format(time.RFC3339),
				Migrated:      read.Migrated,
				LastCompleted: read.LastCompleted,
				LateLast30:    read.LateLast30,
				Sessions:      read.Sessions,
				Versions:      read.Versions,
				Tables:        read.Tables,
			}
			text := fmt.Sprintf("strategy daily: %d session(s) reported, last complete %s, %d late in 30 days",
				distinctSessions(read.Sessions), orNone(read.LastCompleted), read.LateLast30)
			if !read.Migrated {
				text = "strategy daily: the snapshot tables do not exist yet (migration 000155 not applied)"
			}
			return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}, out, nil
		})
	}
	return t
}

// distinctSessions counts the sessions among the phase rows.
func distinctSessions(rows []StrategyPhase) int {
	seen := map[string]bool{}
	for _, r := range rows {
		seen[r.AsOf] = true
	}
	return len(seen)
}

func orNone(s string) string {
	if s == "" {
		return "none"
	}
	return s
}
