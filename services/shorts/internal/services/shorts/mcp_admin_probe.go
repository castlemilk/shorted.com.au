package shorts

// mcp_admin_probe.go: the paid-feature probe behind the admin MCP server's
// paid_feature_status and run_paid_probe tools.
//
// The probe reports to Telesis, one cron monitor per paid feature, and the web
// app runs it. This file reads the monitors through the job monitor's Telesis
// client, and asks the web app to start a run.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/jobmonitor"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
)

// paidFeatureRunsPerMonitor is how many of a feature's newest runs the status
// shows.
const paidFeatureRunsPerMonitor = 5

// PaidFeatureStatus reads each paid-feature monitor and its newest runs.
func (a *adminMCPSource) PaidFeatureStatus(ctx context.Context) (*mcp.PaidFeatureStatusOutput, error) {
	out := &mcp.PaidFeatureStatusOutput{
		ObservedAt: time.Now().UTC().Format(time.RFC3339),
		Features:   []mcp.PaidFeature{},
		Sources:    []mcp.JobSource{},
	}
	history, err := a.CronMonitorsNamed(ctx, mcp.PaidFeatureMonitorPrefix, paidFeatureRunsPerMonitor)
	switch {
	case errors.Is(err, jobmonitor.ErrCronUnconfigured):
		out.Sources = append(out.Sources, mcp.JobSource{Name: "telesis_cron_monitors", Status: "unconfigured",
			Detail: "TELESIS_API_TOKEN and TELESIS_ORG_ID are unset, so the paid-feature probe cannot be read here."})
		return out, nil
	case err != nil:
		// Telesis is set up; it is the read that failed. Configured stays true.
		out.Configured = true
		log.Warnf("admin paid_feature_status: %v", err)
		out.Sources = append(out.Sources, mcp.JobSource{Name: "telesis_cron_monitors", Status: "unavailable",
			Detail: "the Telesis cron monitors could not be read."})
		return out, nil
	}

	out.Configured = true
	detail := fmt.Sprintf("%d paid-feature monitor(s) in Telesis", len(history))
	if len(history) == 0 {
		detail = "no monitor named 'paid-feature: <step>' exists in the Telesis service configured by TELESIS_SERVICE_ID, so the probe has not reported to Telesis. Its steps are entitlement, chat, api_token, gates and all."
	}
	out.Sources = append(out.Sources, mcp.JobSource{Name: "telesis_cron_monitors", Status: "available", Detail: detail})

	runsUnread := 0
	for _, h := range history {
		feature := mcp.PaidFeature{
			Feature:        strings.TrimPrefix(h.Monitor.Name, mcp.PaidFeatureMonitorPrefix),
			Status:         h.Monitor.Status,
			Paused:         h.Monitor.Paused,
			Armed:          h.Monitor.Armed,
			LastRunAt:      h.Monitor.LastRunAt,
			NextExpectedAt: h.Monitor.NextExpectedAt,
		}
		if h.RunsErr != nil {
			// A history that failed is null, never an empty list that reads as
			// "never ran".
			log.Warnf("admin paid_feature_status: runs for %s: %v", feature.Feature, h.RunsErr)
			runsUnread++
		} else {
			feature.RecentRuns = make([]mcp.PaidFeatureRun, 0, len(h.Runs))
			for _, r := range h.Runs {
				feature.RecentRuns = append(feature.RecentRuns, mcp.PaidFeatureRun{
					Status:     r.Status,
					StartedAt:  firstNonEmptyStr(r.StartedAt, r.ExpectedAt),
					DurationMs: r.DurationMs,
					Reason:     r.TerminalReason,
				})
			}
		}
		out.Features = append(out.Features, feature)
	}
	if runsUnread > 0 {
		out.Sources = append(out.Sources, mcp.JobSource{Name: "telesis_cron_runs", Status: "unavailable",
			Detail: fmt.Sprintf("the run history of %d of %d feature monitor(s) could not be read; their recentRuns are null.", runsUnread, len(history))})
	}
	return out, nil
}

// RunPaidProbe runs one probe on the web app, on ctx, and returns its report. A
// run already in progress is a result (InProgress), not an error, and it is decided
// at once: a second caller is refused while the first holds the guard, never queued.
// The guard is this source's, and the web's own 409 is the same answer from the
// other side. The secret is never in the error text.
func (a *adminMCPSource) RunPaidProbe(ctx context.Context) (*mcp.PaidProbeOutput, error) {
	if a.web == nil {
		return nil, errWebUnavailable
	}
	if !a.probing.CompareAndSwap(false, true) {
		return &mcp.PaidProbeOutput{InProgress: true, HTTPStatus: http.StatusConflict, Steps: []mcp.PaidProbeStep{}}, nil
	}
	defer a.probing.Store(false)

	status, report, err := a.web.runPaidProbe(ctx)
	if err != nil {
		log.Warnf("admin run_paid_probe: %v", err)
		return nil, err
	}
	if status == http.StatusConflict {
		return &mcp.PaidProbeOutput{InProgress: true, HTTPStatus: status, Steps: []mcp.PaidProbeStep{}}, nil
	}
	out := &mcp.PaidProbeOutput{
		OK:         report.OK,
		StartedAt:  report.StartedAt,
		DurationMs: report.DurationMs,
		Steps:      make([]mcp.PaidProbeStep, 0, len(report.Steps)),
		Checkins:   report.Checkins,
		HTTPStatus: status,
	}
	for _, s := range report.Steps {
		out.Steps = append(out.Steps, mcp.PaidProbeStep{Name: s.Name, OK: s.OK, DurationMs: s.DurationMs, Detail: s.Detail})
	}
	return out, nil
}
