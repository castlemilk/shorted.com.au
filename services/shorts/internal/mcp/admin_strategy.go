package mcp

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// strategy_status is the read-only view of the strategy engine's daily job: which
// phases ran for the newest sessions, which sessions were held and why, how many
// were backfilled, the canonical versions, the snapshot's table sizes, the backtest
// queue and the newest canonical backtest runs. Every field is an aggregate or a
// run's or session's own facts. It carries no user identifier, no email address and no
// subscription. The one tool here that writes is queue_strategy_backtest, which queues
// a publish of a canonical version and is in this file's registration below.

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
	BacktestQueue []StrategyBacktestQueue
	BacktestRuns  []StrategyBacktestRun
}

// StrategyBacktestQueue is the backtest request queue's length for one kind and status.
type StrategyBacktestQueue struct {
	Kind     string `json:"kind" jsonschema:"publish (a canonical version's run) or variant (a saved variant's run)."`
	Status   string `json:"status" jsonschema:"queued or running."`
	Count    int64  `json:"count"`
	OldestAt string `json:"oldestAt,omitempty" jsonschema:"The oldest request of this group."`
}

// StrategyBacktestRun is one recent canonical backtest run. It names the version by its
// label and never by its rules hash, and carries no user.
type StrategyBacktestRun struct {
	StrategyID     string `json:"strategyId"`
	Label          string `json:"label"`
	Kind           string `json:"kind" jsonschema:"publish, or verify (the record of a publish's second pass)."`
	Status         string `json:"status"`
	State          string `json:"state,omitempty" jsonschema:"computed, or not_computable for a fundamentals strategy whose window has not opened."`
	EngineVersion  string `json:"engineVersion"`
	Published      bool   `json:"published"`
	WindowEnd      string `json:"windowEnd,omitempty"`
	FinishedAt     string `json:"finishedAt,omitempty"`
	DiffState      string `json:"diffState,omitempty" jsonschema:"none (no previous published run), unchanged, or changed."`
	RewrittenCodes int64  `json:"rewrittenCodes" jsonschema:"Codes whose price history up to the previous run's cut-off changed."`
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
	ObservedAt    string                  `json:"observedAt"`
	Migrated      bool                    `json:"migrated" jsonschema:"False when the strategy snapshot tables do not exist yet (migration 000156 not applied)."`
	LastCompleted string                  `json:"lastCompletedSession,omitempty" jsonschema:"The newest session whose features, evaluation and events all completed."`
	LateLast30    int64                   `json:"lateSessionsLast30Days" jsonschema:"Sessions in the last 30 days the job backfilled after their own day."`
	Sessions      []StrategyPhase         `json:"sessions" jsonschema:"Each phase of the newest sessions, newest session first. A held session has one held features row whose note gives the reason."`
	Versions      []StrategyVersion       `json:"versions" jsonschema:"The canonical versions the database records, with status and live_from. Rules hashes are not shown."`
	Tables        []StrategyTable         `json:"tables" jsonschema:"Estimated rows and bytes of each strategy snapshot table."`
	BacktestQueue []StrategyBacktestQueue `json:"backtestQueue" jsonschema:"Queued and running backtest requests by kind and status. Counts only."`
	BacktestRuns  []StrategyBacktestRun   `json:"backtestRuns" jsonschema:"The ten newest canonical backtest runs, newest first. Variant runs never appear."`
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
			Description: "Report the strategy daily job for the newest sessions: each phase's status, held sessions and their reasons, late (backfilled) sessions, the canonical versions, the snapshot table sizes, the backtest queue by kind and status, and the ten newest canonical backtest runs with their publish and diff state. Aggregates only; no user or email data.",
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
				BacktestQueue: read.BacktestQueue,
				BacktestRuns:  read.BacktestRuns,
			}
			text := fmt.Sprintf("strategy daily: %d session(s) reported, last complete %s, %d late in 30 days; backtest queue %d request(s)",
				distinctSessions(read.Sessions), orNone(read.LastCompleted), read.LateLast30, backtestQueued(read.BacktestQueue))
			if !read.Migrated {
				text = "strategy daily: the snapshot tables do not exist yet (migration 000156 not applied)"
			}
			return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}, out, nil
		})
	}
	return t
}

// backtestQueued is the number of queued or running backtest requests of every kind.
func backtestQueued(rows []StrategyBacktestQueue) int64 {
	var n int64
	for _, r := range rows {
		n += r.Count
	}
	return n
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

// ErrStrategyBacktestRefused is a queue request the store refuses (a variant, a version
// that is not live, a missing recipe). Its message is the reason, shown to the model.
var ErrStrategyBacktestRefused = errors.New("strategy backtest refused")

// AdminStrategyBacktestOperator is the optional capability the backtest queue tool needs.
type AdminStrategyBacktestOperator interface {
	StrategyBacktestQueue() StrategyBacktestQueueStore
}

// StrategyBacktestQueueStore queues one canonical version's backtest publish.
type StrategyBacktestQueueStore interface {
	QueueStrategyBacktest(ctx context.Context, req StrategyBacktestQueueRequest) (StrategyBacktestQueueResult, error)
}

// StrategyBacktestQueueRequest is the store's request, in the tool's terms.
type StrategyBacktestQueueRequest struct {
	StrategyID string
	Version    string
	RecipeID   string
	Actor      string
}

// StrategyBacktestQueueResult is the request the store holds for the key.
type StrategyBacktestQueueResult struct {
	RequestID  int64
	StrategyID string
	Label      string
	Status     string
}

// QueueStrategyBacktestInput names the canonical version to backtest.
type QueueStrategyBacktestInput struct {
	StrategyID string `json:"strategy_id,omitempty" jsonschema:"The strategy, for example zanger-breakout. Needed when version is a label."`
	Version    string `json:"version" jsonschema:"A canonical live version: its label (for example v1), or its full 64-character rules hash. Variant hashes are refused."`
	RecipeID   string `json:"recipe_id,omitempty" jsonschema:"The recipe, only when the strategy records more than one."`
}

// QueueStrategyBacktestOutput says what the store holds for the key.
type QueueStrategyBacktestOutput struct {
	RequestID  int64  `json:"requestId"`
	StrategyID string `json:"strategyId"`
	Label      string `json:"label"`
	Status     string `json:"status" jsonschema:"queued (the next hourly backtest execution, at 20 past, runs it) or already_queued (a publish of this key is waiting or running)."`
}

// queueStrategyBacktestTool queues a publish of one canonical live version. The
// scope is jobs:run: it starts work, though the job itself is the scheduled one.
func queueStrategyBacktestTool() AdminTool {
	t := AdminTool{Name: "queue_strategy_backtest", Scope: ScopeJobsRun}
	t.register = func(server *sdk.Server, pub AdminOperator) {
		sdk.AddTool(server, &sdk.Tool{
			Name:  t.Name,
			Title: "Queue a strategy backtest",
			Description: "Queue one publish of a live canonical strategy version's backtest. The backtest job runs it at its next hourly " +
				"execution and publishes it when it passes the gate. Canonical live versions only: a variant or an unregistered version is refused.",
			Annotations: &sdk.ToolAnnotations{ReadOnlyHint: false, DestructiveHint: new(false), IdempotentHint: true, OpenWorldHint: new(false)},
		}, func(ctx context.Context, req *sdk.CallToolRequest, in QueueStrategyBacktestInput) (*sdk.CallToolResult, QueueStrategyBacktestOutput, error) {
			if denied := requireScope(req, t.Scope); denied != nil {
				return denied, QueueStrategyBacktestOutput{}, nil
			}
			op, ok := pub.(AdminStrategyBacktestOperator)
			if !ok || op.StrategyBacktestQueue() == nil {
				return adminToolError(fmt.Errorf("the backtest queue is not wired on this deployment")), QueueStrategyBacktestOutput{}, nil
			}
			res, err := op.StrategyBacktestQueue().QueueStrategyBacktest(ctx, StrategyBacktestQueueRequest{
				StrategyID: strings.TrimSpace(in.StrategyID),
				Version:    strings.TrimSpace(in.Version),
				RecipeID:   strings.TrimSpace(in.RecipeID),
				Actor:      adminActor(req),
			})
			if err != nil {
				return adminToolError(err), QueueStrategyBacktestOutput{}, nil
			}
			out := QueueStrategyBacktestOutput(res)
			text := fmt.Sprintf("%s %s: backtest request %d %s. The next hourly backtest execution runs it; check strategy_status for the run.",
				res.StrategyID, res.Label, res.RequestID, res.Status)
			return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}, out, nil
		})
	}
	return t
}
