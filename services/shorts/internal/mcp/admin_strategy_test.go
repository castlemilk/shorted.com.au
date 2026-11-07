package mcp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"
)

// strategy_status is read-only, needs only jobs:read, and returns no identity.

func TestStrategyStatusIsAJobsReadToolInTheAdminRegistry(t *testing.T) {
	var found *AdminTool
	for _, at := range AdminRegistry() {
		if at.Name == "strategy_status" {
			tool := at
			found = &tool
		}
	}
	if found == nil {
		t.Fatal("strategy_status is not in the admin registry")
	}
	if found.Scope != ScopeJobsRead {
		t.Fatalf("strategy_status requires %q, want %q: a monitoring connection must not need jobs:run", found.Scope, ScopeJobsRead)
	}
	if !slices.Contains(AdminScopes, found.Scope) {
		t.Fatalf("%q is not an admin scope", found.Scope)
	}
}

// The output names sessions, phases, versions and tables. Its JSON carries no
// identifier of a person: no uid, no email, no subscription.
func TestStrategyStatusOutputCarriesNoIdentity(t *testing.T) {
	out := StrategyStatusOutput{
		ObservedAt:    "2026-11-12T14:00:00Z",
		Migrated:      true,
		LastCompleted: "2026-11-12",
		LateLast30:    2,
		Sessions:      []StrategyPhase{{AsOf: "2026-11-12", Phase: "features", Status: "completed", Counts: `{"codes":2}`}},
		Versions:      []StrategyVersion{{StrategyID: "zanger-breakout", Label: "v0", Status: "live", LiveFrom: "2026-11-01"}},
		Tables:        []StrategyTable{{Name: "strategy_features_daily", RowsEst: 2500, SizeBytes: 1 << 20}},
	}
	raw, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	body := strings.ToLower(string(raw))
	for _, banned := range []string{`"uid"`, "email", "user_id", "userid", "subscription", "rules_hash"} {
		if strings.Contains(body, banned) {
			t.Errorf("strategy_status output must not carry %q: %s", banned, raw)
		}
	}
	for _, key := range []string{`"sessions"`, `"versions"`, `"tables"`, `"latesessionslast30days"`, `"migrated"`} {
		if !strings.Contains(body, key) {
			t.Errorf("strategy_status output is missing %s: %s", key, raw)
		}
	}
}

// queue_strategy_backtest starts work, so it needs jobs:run, not jobs:read.
func TestQueueStrategyBacktestIsAJobsRunTool(t *testing.T) {
	var found *AdminTool
	for _, at := range AdminRegistry() {
		if at.Name == "queue_strategy_backtest" {
			tool := at
			found = &tool
		}
	}
	if found == nil {
		t.Fatal("queue_strategy_backtest is not in the admin registry")
	}
	if found.Scope != ScopeJobsRun {
		t.Fatalf("queue_strategy_backtest requires %q, want %q", found.Scope, ScopeJobsRun)
	}
}

// A queued request reaches the store with the caller's actor, and the answer names
// the request and its status without the caller's identity.
func TestAnAdminQueuesACanonicalBacktestAndTheActorStaysInside(t *testing.T) {
	pub := &fakePublisher{}
	srv := adminStack(t, stubClaims{claims: adminClaims()}, onlyAdmin("uid-admin"), pub)
	call := `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"queue_strategy_backtest","arguments":{"strategy_id":"zanger-breakout","version":"v1"}}}`
	resp, body := adminCall(t, srv, "t", call)
	if resp.StatusCode != http.StatusOK || strings.Contains(body, `"isError":true`) {
		t.Fatalf("status = %d body = %s", resp.StatusCode, body)
	}
	if pub.backtest.StrategyID != "zanger-breakout" || pub.backtest.Version != "v1" || pub.backtest.Actor != "oauth:uid-admin" {
		t.Fatalf("queue request = %+v", pub.backtest)
	}
	if !strings.Contains(body, `"status":"queued"`) || !strings.Contains(body, `"requestId":41`) {
		t.Fatalf("response lacks the request: %s", body)
	}
	if strings.Contains(body, "uid-admin") || strings.Contains(strings.ToLower(body), "email") {
		t.Fatalf("the answer carries an identity: %s", body)
	}
}

// A variant hash is refused by the store; the model gets a tool error, not a request.
func TestQueueStrategyBacktestRefusesAVariantAsAToolError(t *testing.T) {
	pub := &fakePublisher{backtestErr: fmt.Errorf("%w: the version names a variant; only canonical versions are backtested here", ErrStrategyBacktestRefused)}
	srv := adminStack(t, stubClaims{claims: adminClaims()}, onlyAdmin("uid-admin"), pub)
	call := `{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"queue_strategy_backtest","arguments":{"version":"` + strings.Repeat("a", 64) + `"}}}`
	resp, body := adminCall(t, srv, "t", call)
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"isError":true`) || !strings.Contains(body, "variant") {
		t.Fatalf("status = %d body = %s; want a tool error naming the variant", resp.StatusCode, body)
	}
}

// strategy_status's new run and queue fields carry no identity either.
func TestStrategyStatusRunAndQueueFieldsCarryNoIdentity(t *testing.T) {
	out := StrategyStatusOutput{
		Migrated:      true,
		BacktestQueue: []StrategyBacktestQueue{{Kind: "publish", Status: "queued", Count: 2, OldestAt: "2026-11-12T20:00:00Z"}},
		BacktestRuns: []StrategyBacktestRun{{StrategyID: "zanger-breakout", Label: "v1", Kind: "publish", Status: "succeeded",
			State: "computed", EngineVersion: "1.1.0", Published: true, DiffState: "changed", RewrittenCodes: 3}},
	}
	raw, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	body := strings.ToLower(string(raw))
	// Output keys are camelCase, so the snake_case and camelCase forms are both banned.
	for _, banned := range []string{`"uid"`, "email", "user_id", "userid", "alert", "variant", "rules_hash", "ruleshash", "requested_by", "requestedby"} {
		if strings.Contains(body, banned) {
			t.Errorf("strategy_status must not carry %q: %s", banned, raw)
		}
	}
	for _, key := range []string{`"backtestqueue"`, `"backtestruns"`, `"diffstate"`} {
		if !strings.Contains(body, key) {
			t.Errorf("strategy_status is missing %s: %s", key, raw)
		}
	}
}
