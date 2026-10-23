package shorts

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/jobmonitor"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
)

// telesisFake serves the two Telesis cron calls the paid-feature status makes.
// runs maps a monitor id to its runs JSON, or to "ERR" for a failing read.
func telesisFake(t *testing.T, monitors string, runs map[string]string) *jobmonitor.Collector {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/uptimeapi.v1.CronMonitorService/ListCronMonitors":
			_, _ = io.WriteString(w, monitors)
		case "/uptimeapi.v1.CronMonitorService/ListCronRuns":
			raw, _ := io.ReadAll(r.Body)
			var body struct {
				CronMonitorID string `json:"cronMonitorId"`
			}
			_ = json.Unmarshal(raw, &body)
			if runs[body.CronMonitorID] == "ERR" {
				http.Error(w, "boom", http.StatusInternalServerError)
				return
			}
			_, _ = io.WriteString(w, runs[body.CronMonitorID])
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return jobmonitor.NewCollector(jobmonitor.Config{Telesis: jobmonitor.TelesisConfig{BaseURL: srv.URL, Token: "upk_test", OrgID: "org-1"}})
}

const paidFeatureMonitorsJSON = `{"monitors":[
  {"id":"m-chat","name":"paid-feature: chat","status":"CRON_MONITOR_STATUS_FAILING","paused":false,"lastRunAt":"2026-10-23T10:00:00Z","nextExpectedAt":"2026-10-23T11:00:00Z"},
  {"id":"m-ent","name":"paid-feature: entitlement","status":"CRON_MONITOR_STATUS_HEALTHY","paused":true},
  {"id":"m-news","name":"shorted-news","status":"CRON_MONITOR_STATUS_HEALTHY","paused":false}
 ],"pageInfo":{}}`

const chatRunsJSON = `{"runs":[{"runId":"chat-2","status":"CRON_RUN_STATUS_FAILED","startedAt":"2026-10-23T10:00:00Z","durationMs":"1200","terminalReason":"gemini timeout"}]}`

// The status reads only paid-feature monitors, says whether each is armed, and
// names a feature whose run history failed rather than showing it as never run.
func TestPaidFeatureStatusReadsEachFeatureThroughTelesis(t *testing.T) {
	src := &adminMCPSource{Collector: telesisFake(t, paidFeatureMonitorsJSON, map[string]string{"m-chat": chatRunsJSON, "m-ent": "ERR"})}
	out, err := src.PaidFeatureStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !out.Configured || len(out.Features) != 2 {
		t.Fatalf("configured %v, features %+v; want two paid-feature monitors and nothing else", out.Configured, out.Features)
	}
	chat, ent := out.Features[0], out.Features[1]
	if chat.Feature != "chat" || chat.Status != "failing" || !chat.Armed || chat.Paused {
		t.Errorf("chat = %+v", chat)
	}
	if len(chat.RecentRuns) != 1 || chat.RecentRuns[0].Reason != "gemini timeout" || chat.RecentRuns[0].Status != "failed" || chat.RecentRuns[0].DurationMs != 1200 {
		t.Errorf("chat runs = %+v", chat.RecentRuns)
	}
	if ent.Feature != "entitlement" || !ent.Paused || ent.Armed {
		t.Errorf("entitlement = %+v: a paused monitor is not armed", ent)
	}
	if ent.RecentRuns != nil {
		t.Errorf("entitlement runs = %+v, want null when its history could not be read", ent.RecentRuns)
	}
	if sourceStatus(out.Sources, "telesis_cron_runs") != "unavailable" {
		t.Errorf("sources = %+v, want the failed run read named", out.Sources)
	}
}

func TestPaidFeatureStatusStatesItsConfiguration(t *testing.T) {
	// Telesis not set up: not an error, and the output says so.
	out, err := (&adminMCPSource{Collector: jobmonitor.NewCollector(jobmonitor.Config{})}).PaidFeatureStatus(context.Background())
	if err != nil || out.Configured || len(out.Features) != 0 || sourceStatus(out.Sources, "telesis_cron_monitors") != "unconfigured" {
		t.Fatalf("unconfigured: %+v, %v", out, err)
	}
	// Telesis set up but the monitors cannot be read: unavailable, not zero features.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusInternalServerError)
	}))
	defer srv.Close()
	down := jobmonitor.NewCollector(jobmonitor.Config{Telesis: jobmonitor.TelesisConfig{BaseURL: srv.URL, Token: "upk_test", OrgID: "org-1"}})
	out, err = (&adminMCPSource{Collector: down}).PaidFeatureStatus(context.Background())
	if err != nil || !out.Configured || sourceStatus(out.Sources, "telesis_cron_monitors") != "unavailable" {
		t.Fatalf("monitors down: %+v, %v", out, err)
	}
	// Configured with no paid-feature monitor yet: available, and the detail says the probe has not reported.
	out, err = (&adminMCPSource{Collector: telesisFake(t, `{"monitors":[{"id":"m-news","name":"shorted-news"}],"pageInfo":{}}`, nil)}).PaidFeatureStatus(context.Background())
	if err != nil || len(out.Features) != 0 || !strings.Contains(sourceDetail(out.Sources, "telesis_cron_monitors"), "has not reported") {
		t.Fatalf("no feature monitors: %+v, %v", out, err)
	}
}

// probeWeb serves the paid-probe route only, with the given answer.
func probeWeb(t *testing.T, status int, body string) *adminWebClient {
	t.Helper()
	web := &billingWeb{probeStatus: status, probeBody: body}
	srv := httptest.NewServer(web)
	t.Cleanup(srv.Close)
	return &adminWebClient{checkURL: srv.URL + "/api/internal/admin-check", secret: billingTestSecret, client: srv.Client()}
}

const passingProbe = `{"ok":true,"startedAt":"2026-10-23T00:00:00Z","durationMs":9000,"checkins":"sent","steps":[{"name":"entitlement","ok":true,"durationMs":40},{"name":"chat","ok":true,"durationMs":800}]}`
const failingProbe = `{"ok":false,"startedAt":"2026-10-23T00:00:00Z","durationMs":9000,"checkins":"partial","steps":[{"name":"entitlement","ok":true,"durationMs":40},{"name":"chat","ok":false,"durationMs":500,"detail":"upstream 500"}]}`

func TestRunPaidProbePassesEachAnswerThrough(t *testing.T) {
	ctx := context.Background()

	out, err := (&adminMCPSource{web: probeWeb(t, http.StatusOK, passingProbe)}).RunPaidProbe(ctx)
	if err != nil || !out.OK || out.HTTPStatus != 200 || len(out.Steps) != 2 || out.Checkins != "sent" || out.InProgress {
		t.Fatalf("200: %+v, %v", out, err)
	}

	// 503 is a report of a failed step, not an error.
	out, err = (&adminMCPSource{web: probeWeb(t, http.StatusServiceUnavailable, failingProbe)}).RunPaidProbe(ctx)
	if err != nil || out.OK || out.HTTPStatus != 503 || out.Steps[1].Name != "chat" || out.Steps[1].Detail != "upstream 500" {
		t.Fatalf("503: %+v, %v", out, err)
	}

	// 409: another run holds the probe. Nothing started, and no error.
	out, err = (&adminMCPSource{web: probeWeb(t, http.StatusConflict, "")}).RunPaidProbe(ctx)
	if err != nil || !out.InProgress || out.HTTPStatus != 409 {
		t.Fatalf("409: %+v, %v", out, err)
	}
}

// The probe is not cut by the request's own deadline: a caller whose context
// is already done still gets the web app's answer.
func TestRunPaidProbeIsNotCutByTheRequestDeadline(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	out, err := (&adminMCPSource{web: probeWeb(t, http.StatusOK, passingProbe)}).RunPaidProbe(ctx)
	if err != nil || !out.OK {
		t.Fatalf("out %+v, err %v: a done request context must not stop the probe", out, err)
	}
}

// 401 and other refusals are errors naming the status, and never the secret.
func TestRunPaidProbeRefusalsAreErrorsThatNameTheStatus(t *testing.T) {
	ctx := context.Background()
	_, err := (&adminMCPSource{web: probeWeb(t, http.StatusUnauthorized, "")}).RunPaidProbe(ctx)
	if err == nil || !strings.Contains(err.Error(), "HTTP 401") {
		t.Fatalf("401 err = %v", err)
	}
	if strings.Contains(err.Error(), billingTestSecret) {
		t.Fatalf("the secret reached an error: %v", err)
	}
	_, err = (&adminMCPSource{web: probeWeb(t, http.StatusInternalServerError, "")}).RunPaidProbe(ctx)
	if err == nil || !strings.Contains(err.Error(), "HTTP 500") {
		t.Fatalf("500 err = %v", err)
	}
}

func TestRunPaidProbeWithoutTheWebAppIsAnError(t *testing.T) {
	if _, err := (&adminMCPSource{}).RunPaidProbe(context.Background()); err == nil || !strings.Contains(err.Error(), "INTERNAL_SERVICE_SECRET") {
		t.Fatalf("err = %v, want the unconfigured state named", err)
	}
}

// The web client authenticates with the header, and derives each route from the
// admin-check URL, as the admin-users client does.
func TestAdminWebClientSendsTheSecretAndDerivesRoutes(t *testing.T) {
	c := &adminWebClient{checkURL: "https://web.example/api/internal/admin-check", secret: "s"}
	if got := c.route("billing"); got != "https://web.example/api/internal/billing" {
		t.Fatalf("route = %s", got)
	}
	if got := c.route("paid-probe"); got != "https://web.example/api/internal/paid-probe" {
		t.Fatalf("route = %s", got)
	}

	t.Setenv("INTERNAL_SERVICE_SECRET", "")
	if newAdminWebClientFromEnv() != nil {
		t.Fatal("no secret must give no client: the routes cannot be authenticated")
	}
	t.Setenv("INTERNAL_SERVICE_SECRET", "s")
	t.Setenv("ADMIN_CHECK_URL", "https://other.example/api/internal/admin-check")
	if c := newAdminWebClientFromEnv(); c == nil || c.route("billing") != "https://other.example/api/internal/billing" {
		t.Fatalf("client from env = %+v", c)
	}
}

// paid_feature_status and run_paid_probe are wired on the source the admin
// server is built over.
var _ mcp.AdminProbeOperator = (*adminMCPSource)(nil)
var _ mcp.AdminBillingReader = (*adminMCPSource)(nil)
