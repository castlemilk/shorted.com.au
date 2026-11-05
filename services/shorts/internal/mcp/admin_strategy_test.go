package mcp

import (
	"encoding/json"
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
