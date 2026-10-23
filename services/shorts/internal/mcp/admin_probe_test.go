package mcp

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// probeFixture is what the fake operator answers for the paid-feature tools.
var probeFixture struct {
	status      *PaidFeatureStatusOutput
	probe       *PaidProbeOutput
	probeErr    error
	probeCalls  int
	deadline    time.Time
	hasDeadline bool
}

func (f *fakePublisher) PaidFeatureStatus(context.Context) (*PaidFeatureStatusOutput, error) {
	if probeFixture.status != nil {
		return probeFixture.status, nil
	}
	return &PaidFeatureStatusOutput{Configured: true, Features: []PaidFeature{}, Sources: []JobSource{}}, nil
}

func (f *fakePublisher) RunPaidProbe(ctx context.Context) (*PaidProbeOutput, error) {
	probeFixture.probeCalls++
	probeFixture.deadline, probeFixture.hasDeadline = ctx.Deadline()
	if probeFixture.probeErr != nil {
		return nil, probeFixture.probeErr
	}
	if probeFixture.probe != nil {
		return probeFixture.probe, nil
	}
	return &PaidProbeOutput{OK: true, HTTPStatus: 200, Checkins: "disabled", Steps: []PaidProbeStep{}}, nil
}

const runPaidProbeCall = `{"name":"run_paid_probe","arguments":{}}`

func TestPaidFeatureStatusReportsEachFeatureAndItsRuns(t *testing.T) {
	probeFixture.status = &PaidFeatureStatusOutput{
		ObservedAt: "2026-10-23T00:00:00Z",
		Configured: true,
		Features: []PaidFeature{{
			Feature: "chat", Status: "failing", Armed: true, LastRunAt: "2026-10-23T00:00:00Z",
			RecentRuns: []PaidFeatureRun{{Status: "failed", DurationMs: 1200, Reason: "gemini timeout"}},
		}},
		Sources: []JobSource{{Name: "telesis_cron_monitors", Status: "available"}},
	}
	defer func() { probeFixture.status = nil }()

	body := peopleCall(t, []string{ScopeJobsRead}, `{"name":"paid_feature_status","arguments":{}}`)
	for _, want := range []string{`"feature":"chat"`, `"status":"failing"`, `"armed":true`, `"reason":"gemini timeout"`, `"configured":true`} {
		if !strings.Contains(body, want) {
			t.Fatalf("body lacks %s: %s", want, body)
		}
	}
}

// Telesis not being set up is a state the tool reports, not a refusal.
func TestPaidFeatureStatusUnconfiguredIsNotAnError(t *testing.T) {
	probeFixture.status = &PaidFeatureStatusOutput{
		Configured: false,
		Features:   []PaidFeature{},
		Sources:    []JobSource{{Name: "telesis_cron_monitors", Status: "unconfigured", Detail: "TELESIS_API_TOKEN and TELESIS_ORG_ID are unset"}},
	}
	defer func() { probeFixture.status = nil }()

	body := peopleCall(t, []string{ScopeJobsRead}, `{"name":"paid_feature_status","arguments":{}}`)
	if strings.Contains(body, `"isError":true`) || !strings.Contains(body, `"configured":false`) || !strings.Contains(body, `"unconfigured"`) {
		t.Fatalf("body = %s, want configured=false as a result", body)
	}
}

func TestRunPaidProbePassesTheReportThrough(t *testing.T) {
	probeFixture.probe = &PaidProbeOutput{
		OK: true, StartedAt: "2026-10-23T00:00:00Z", DurationMs: 9000, Checkins: "sent", HTTPStatus: 200,
		Steps: []PaidProbeStep{{Name: "entitlement", OK: true, DurationMs: 40}, {Name: "chat", OK: true, DurationMs: 800}},
	}
	defer func() { probeFixture.probe = nil }()

	body := peopleCall(t, []string{ScopeJobsRun}, `{"name":"run_paid_probe","arguments":{}}`)
	if strings.Contains(body, `"isError":true`) {
		t.Fatalf("a passing probe became a tool error: %s", body)
	}
	for _, want := range []string{`"ok":true`, `"checkins":"sent"`, `"name":"chat"`, "passed: 2 steps, check-ins sent"} {
		if !strings.Contains(body, want) {
			t.Fatalf("body lacks %s: %s", want, body)
		}
	}
}

// A failed step is a report (the web app answers 503 with the steps), not a
// tool error: the model needs the steps to say what broke.
func TestRunPaidProbeReportsAFailedStepAsAResult(t *testing.T) {
	probeFixture.probe = &PaidProbeOutput{
		OK: false, HTTPStatus: 503, Checkins: "partial",
		Steps: []PaidProbeStep{{Name: "entitlement", OK: true}, {Name: "chat", OK: false, Detail: "upstream 500"}},
	}
	defer func() { probeFixture.probe = nil }()

	body := peopleCall(t, []string{ScopeJobsRun}, runPaidProbeCall)
	if strings.Contains(body, `"isError":true`) {
		t.Fatalf("a failed probe became a tool error: %s", body)
	}
	for _, want := range []string{`"ok":false`, `"httpStatus":503`, "FAILED at chat, check-ins partial", `"detail":"upstream 500"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("body lacks %s: %s", want, body)
		}
	}
}

// 409: another run holds the probe. The call starts nothing and says so.
func TestRunPaidProbeInProgressIsAResultNotAnError(t *testing.T) {
	probeFixture.probe = &PaidProbeOutput{InProgress: true, HTTPStatus: 409}
	defer func() { probeFixture.probe = nil }()

	body := peopleCall(t, []string{ScopeJobsRun}, runPaidProbeCall)
	if strings.Contains(body, `"isError":true`) || !strings.Contains(body, "a probe run is already in progress") || !strings.Contains(body, `"inProgress":true`) {
		t.Fatalf("body = %s, want an in-progress result", body)
	}
}

// 401 and other failures are errors the model can act on, with the status.
func TestRunPaidProbeFailureIsAToolError(t *testing.T) {
	probeFixture.probeErr = errors.New("paid probe: the web app rejected the internal secret (HTTP 401)")
	defer func() { probeFixture.probeErr = nil }()

	body := peopleCall(t, []string{ScopeJobsRun}, runPaidProbeCall)
	if !strings.Contains(body, `"isError":true`) || !strings.Contains(body, "HTTP 401") {
		t.Fatalf("body = %s, want a tool error carrying the status", body)
	}
}

// A connection without jobs:run must not start a probe, even one that would
// only be refused by the web app.
func TestRunPaidProbeIsNotStartedWithoutTheScope(t *testing.T) {
	probeFixture.probeCalls = 0
	body := peopleCall(t, []string{ScopeJobsRead}, runPaidProbeCall)
	if !strings.Contains(body, `"isError":true`) || probeFixture.probeCalls != 0 {
		t.Fatalf("jobs:read started a probe (%d calls): %s", probeFixture.probeCalls, body)
	}
}

// run_paid_probe runs synchronously inside the call, bounded at PaidProbeTimeout,
// which sits under the 90-second request bound.
func TestRunPaidProbeIsBoundedAt85Seconds(t *testing.T) {
	probeFixture.hasDeadline = false
	peopleCall(t, []string{ScopeJobsRun}, runPaidProbeCall)
	if !probeFixture.hasDeadline {
		t.Fatal("the probe ran with no deadline")
	}
	left := time.Until(probeFixture.deadline)
	if left > PaidProbeTimeout || left < PaidProbeTimeout-10*time.Second {
		t.Fatalf("deadline in %s, want about %s", left, PaidProbeTimeout)
	}
	if PaidProbeTimeout != 85*time.Second {
		t.Fatalf("PaidProbeTimeout = %s, want 85s", PaidProbeTimeout)
	}
}
