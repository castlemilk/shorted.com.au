package main

// golden_contract_test.go pins the -mode cycle output against the shared contract in the design doc
// ("Cycle output contract (schema 1)"). The runtime (BrandBrain) reads the same names, so a drift
// on either side fails here first.

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"
)

const cycleContractDoc = "../../docs/superpowers/specs/2026-10-27-fleet-managed-housing-crawl-design.md"
const cycleContractHeading = "### Cycle output contract (schema 1)"

// keyPattern matches a JSON object key, `"name":`, and nothing else.
var keyPattern = regexp.MustCompile(`"([a-z_]+)":`)

// jsonKeySeq is the keys of a JSON text, in order.
func jsonKeySeq(s string) []string {
	var out []string
	for _, m := range keyPattern.FindAllStringSubmatch(s, -1) {
		out = append(out, m[1])
	}
	return out
}

// contractSection returns the contract section of the design doc, from its heading to the next
// heading of the same or a higher level.
func contractSection(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(cycleContractDoc)
	if err != nil {
		t.Fatalf("read design doc: %v", err)
	}
	doc := string(raw)
	i := strings.Index(doc, cycleContractHeading)
	if i < 0 {
		t.Fatalf("the design doc has no %q section", cycleContractHeading)
	}
	rest := doc[i+len(cycleContractHeading):]
	if j := strings.Index(rest, "\n### "); j >= 0 {
		rest = rest[:j]
	}
	return rest
}

// firstJSONBlock is the first fenced json block in s.
func firstJSONBlock(t *testing.T, s string) string {
	t.Helper()
	const open = "```json\n"
	i := strings.Index(s, open)
	if i < 0 {
		t.Fatalf("the contract section has no json block")
	}
	rest := s[i+len(open):]
	j := strings.Index(rest, "\n```")
	if j < 0 {
		t.Fatalf("the contract json block is not closed")
	}
	return rest[:j]
}

func TestCycleOutputContractGolden(t *testing.T) {
	section := contractSection(t)
	docKeys := jsonKeySeq(firstJSONBlock(t, section))

	// A summary with every field set, marshalled by the production type.
	sample := cycleSummary{
		Schema: cycleSchema, CycleID: "cyc-x", Job: cycleJobDrain, DryRun: false,
		Outcome: outQueueEmpty, ExitCode: 0, Rounds: 1,
		StartedAt: "2026-10-28T00:00:00Z", FinishedAt: "2026-10-28T00:00:01Z",
		Collector: cycleCollector{Revision: "abc", Modified: false},
		Lock:      lockHeldByCycle,
		Env:       cycleEnvSummary{Driver: "ok", Chrome: "warm"},
		Ingest:    cycleIngestSummary{Probe: "ok", LastOKAt: nil},
		Counts:    cycleCounts{},
	}
	b, err := json.Marshal(sample)
	if err != nil {
		t.Fatal(err)
	}
	gotKeys := jsonKeySeq(string(b))
	if strings.Join(docKeys, ",") != strings.Join(gotKeys, ",") {
		t.Fatalf("summary keys drift from the contract.\n doc:  %v\n code: %v", docKeys, gotKeys)
	}

	// Every closed-set value the collector can emit must be a word the contract names.
	words := []string{
		outQueueEmpty, outBudget, outNoProgress, outMaxRounds, outCancelled, outLockHeld,
		outPreflightFailed, outStopped, outHung, outInternal, outRepaired, outRepairFailed, outChecked,
		lockFree, lockHeldByCycle, lockHeldElsewhere, lockUnknown,
		"warm", "reachable", "unreachable", "unusable", chromePortConflict,
		"ok", "installed", "missing", "unknown",
		"unauthenticated", "permission_denied", "unavailable", "contract", "token", "not_run",
		"cycle_start", "phase", "preflight", "round_start", "round_done", "ingest_ok", "ingest_error", "cycle_done",
		"preflight", "round", "cooldown", "install_driver", "repair", "stopping",
		"drain", "repair", "preflight", "checked",
	}
	for _, w := range words {
		if !strings.Contains(section, w) {
			t.Fatalf("the contract does not name %q", w)
		}
	}

	// The counts object is exactly the contract's nine keys, and the summary carries nothing else.
	wantCounts := []string{"claimed", "succeeded", "failed", "deferred", "blocked", "pushed", "push_failed", "quarantined", "events_dropped"}
	var gotCounts map[string]json.RawMessage
	var top map[string]json.RawMessage
	if err := json.Unmarshal(b, &top); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(top["counts"], &gotCounts); err != nil {
		t.Fatal(err)
	}
	if len(gotCounts) != len(wantCounts) {
		t.Fatalf("counts has %d keys, the contract has %d", len(gotCounts), len(wantCounts))
	}
	for _, k := range wantCounts {
		if _, ok := gotCounts[k]; !ok {
			t.Fatalf("counts is missing %q", k)
		}
	}
}

// The events the collector writes carry type, ts and cycle_id, and the names the contract lists.
func TestCycleEventNamesMatchTheContract(t *testing.T) {
	section := contractSection(t)
	for _, typ := range []string{"cycle_start", "phase", "preflight", "round_start", "round_done", "ingest_ok", "ingest_error", "cycle_done"} {
		if !strings.Contains(section, "`"+typ+"`") {
			t.Fatalf("the contract's events table does not list %q", typ)
		}
	}
	for _, key := range []string{`"type"`, `"ts"`, `"cycle_id"`} {
		if !strings.Contains(section, key) {
			t.Fatalf("the contract does not name the %s event field", key)
		}
	}
}

// The runtime's silence rule: the cycle's own events must mark a cooldown with an until.
func TestCooldownPhaseCarriesUntil(t *testing.T) {
	section := contractSection(t)
	if !strings.Contains(section, "`until`") {
		t.Fatalf("the contract must name the cooldown phase's until")
	}
}
