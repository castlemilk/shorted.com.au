package mcp

// admin_probe.go: the paid-feature probe, as admins see it. Two tools:
//
//   - paid_feature_status (jobs:read) reads the Telesis cron monitors the probe
//     reports to, one per paid feature ("paid-feature: <feature>"). It is
//     monitoring, so it sits with the job tools, not behind users:read.
//   - run_paid_probe (jobs:run) starts one probe run on the web app, which
//     exercises each paid feature as a real subscriber would. It is an action,
//     so it carries the same scope as run_picks_job.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
)

// PaidProbeTimeout bounds one run_paid_probe call. The request itself is bounded
// at StreamLifetime (90s), and the probe's own worst case on the web side is about
// 75s, so 85s lets a slow run finish while the call still returns before the
// request is cut. A call that runs past it fails, and the run may still complete on
// the web side: paid_feature_status shows its outcome.
const PaidProbeTimeout = 85 * time.Second

// AdminProbeOperator is the paid-feature half of the admin operator.
type AdminProbeOperator interface {
	PaidFeatureStatus(context.Context) (*PaidFeatureStatusOutput, error)
	RunPaidProbe(context.Context) (*PaidProbeOutput, error)
}

// PaidFeatureMonitorPrefix names the Telesis cron monitors of the paid-feature
// probe. Every monitor whose name starts with it is one feature.
const PaidFeatureMonitorPrefix = "paid-feature: "

// PaidFeatureStatusOutput is the probe's monitoring view.
type PaidFeatureStatusOutput struct {
	ObservedAt string        `json:"observedAt"`
	Configured bool          `json:"configured" jsonschema:"False when Telesis is not configured on this deployment. features is then empty and that is not a finding."`
	Features   []PaidFeature `json:"features"`
	Sources    []JobSource   `json:"sources"`
}

// PaidFeature is one paid feature's monitor and its newest runs.
type PaidFeature struct {
	Feature        string           `json:"feature" jsonschema:"The monitor name after 'paid-feature: ', e.g. entitlement, chat, api_token, gates, all."`
	Status         string           `json:"status" jsonschema:"Telesis monitor status: waiting | healthy | running | late | failing | paused."`
	Paused         bool             `json:"paused"`
	Armed          bool             `json:"armed" jsonschema:"Telesis' armed flag: true only after the monitor's first check-in. An armed monitor alerts on a missed run; an unarmed one has not reported yet, so a missed run cannot alert."`
	LastRunAt      string           `json:"lastRunAt,omitempty"`
	NextExpectedAt string           `json:"nextExpectedAt,omitempty"`
	RecentRuns     []PaidFeatureRun `json:"recentRuns" jsonschema:"The newest runs, newest first. Null when this feature's run history could not be read (see sources)."`
}

// PaidFeatureRun is one run of the probe for a feature.
type PaidFeatureRun struct {
	Status     string `json:"status" jsonschema:"running | succeeded | failed | missed | timed_out."`
	StartedAt  string `json:"startedAt,omitempty"`
	DurationMs int64  `json:"durationMs"`
	Reason     string `json:"reason,omitempty" jsonschema:"Telesis' terminal reason for a run that did not succeed."`
}

// PaidProbeOutput is one probe run's report, as the web app returns it.
type PaidProbeOutput struct {
	OK         bool            `json:"ok" jsonschema:"True when every step passed."`
	InProgress bool            `json:"inProgress,omitempty" jsonschema:"A probe was already running. This call did not start one, and the other run's report is not returned."`
	StartedAt  string          `json:"startedAt,omitempty"`
	DurationMs int64           `json:"durationMs"`
	Steps      []PaidProbeStep `json:"steps"`
	Checkins   string          `json:"checkins,omitempty" jsonschema:"disabled | sent | partial: whether the run reported to the paid-feature monitors."`
	HTTPStatus int             `json:"httpStatus" jsonschema:"200 on success, 503 when a step failed, 502 when every step passed but a Telesis check-in was refused or misconfigured, 409 when a run was already in progress."`
}

// PaidProbeStep is one check the probe made.
type PaidProbeStep struct {
	Name       string `json:"name"`
	OK         bool   `json:"ok"`
	DurationMs int64  `json:"durationMs"`
	Detail     string `json:"detail,omitempty"`
}

// --- paid_feature_status ---------------------------------------------------

func paidFeatureStatusTool() AdminTool {
	return adminScopedReadTool(ScopeJobsRead, "paid_feature_status", "Paid-feature probe status",
		"Each paid feature's probe monitor (Telesis, \"paid-feature: <feature>\"): its status, whether it is paused or armed, when it last ran "+
			"and is next expected, and its five newest runs with their failure reasons. A feature with no run yet reads waiting. configured is "+
			"false when Telesis is not set up on this deployment; that is not an error. Read run_paid_probe to start a probe run.",
		nil, func(ctx context.Context, op AdminOperator, _ *sdk.CallToolRequest, _ struct{}) (*PaidFeatureStatusOutput, error) {
			return op.PaidFeatureStatus(ctx)
		})
}

// --- run_paid_probe --------------------------------------------------------

func runPaidProbeTool() AdminTool {
	t := AdminTool{Name: "run_paid_probe", Scope: ScopeJobsRun}
	t.register = func(server *sdk.Server, pub AdminOperator) {
		sdk.AddTool(server, &sdk.Tool{
			Name:  t.Name,
			Title: "Run the paid-feature probe",
			Description: "Start one run of the paid-feature probe on the web app: it exercises each paid feature as a real subscriber " +
				"(entitlement, chat, API tokens, gates) and reports each step. The run happens inside this call and the report comes back " +
				"with it; the call is bounded at 85 seconds. Only one run is allowed at a time: a second call while one is in progress " +
				"returns at once and starts nothing. Results also land in paid_feature_status when the run reports to Telesis.",
			Annotations: &sdk.ToolAnnotations{
				ReadOnlyHint:    false,
				DestructiveHint: new(false),
				IdempotentHint:  false,
				OpenWorldHint:   new(true), // the probe calls live feature endpoints
			},
		}, func(ctx context.Context, req *sdk.CallToolRequest, _ struct{}) (*sdk.CallToolResult, PaidProbeOutput, error) {
			if denied := requireScope(req, t.Scope); denied != nil {
				return denied, PaidProbeOutput{}, nil
			}
			log.Infof("admin run_paid_probe: actor=%s", adminActor(req))
			// The probe runs on this request's context, so the connector's own bound
			// is the one that applies; PaidProbeTimeout keeps it under the stream bound.
			ctx, cancel := context.WithTimeout(ctx, PaidProbeTimeout)
			defer cancel()
			out, err := pub.RunPaidProbe(ctx)
			if err == nil && out == nil {
				err = errors.New("paid probe: the web app returned no report")
			}
			if err != nil {
				return toolFailure(err), PaidProbeOutput{}, nil
			}
			return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: paidProbeText(out)}}}, *out, nil
		})
	}
	return t
}

// paidProbeText says what the run did in one line, naming the failed steps.
func paidProbeText(out *PaidProbeOutput) string {
	if out.InProgress {
		return "a probe run is already in progress; nothing was started. Read paid_feature_status for the outcome of the run in progress."
	}
	checkins := firstNonEmptyText(out.Checkins, "disabled")
	if out.OK {
		return fmt.Sprintf("Paid-feature probe passed: %d steps, check-ins %s.", len(out.Steps), checkins)
	}
	var failed []string
	for _, s := range out.Steps {
		if !s.OK {
			failed = append(failed, s.Name)
		}
	}
	if len(failed) == 0 {
		return fmt.Sprintf("Paid-feature probe FAILED, check-ins %s.", checkins)
	}
	return fmt.Sprintf("Paid-feature probe FAILED at %s, check-ins %s.", strings.Join(failed, ", "), checkins)
}

func firstNonEmptyText(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// toolFailure turns a source error into a tool-level error the model can read.
// The source's messages are written to be safe to show (no secrets, no ids).
func toolFailure(err error) *sdk.CallToolResult {
	res := &sdk.CallToolResult{}
	res.SetError(err)
	return res
}
