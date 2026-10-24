package shorts

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

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

// paidFeatureMonitorsJSON: chat has checked in (armed); entitlement is paused;
// gates is live but has never checked in, so it is not armed even though it is
// not paused. The shorted-news monitor is not a paid-feature one and must not show.
const paidFeatureMonitorsJSON = `{"monitors":[
  {"id":"m-chat","name":"paid-feature: chat","status":"CRON_MONITOR_STATUS_FAILING","paused":false,"armed":true,"lastRunAt":"2026-10-23T10:00:00Z","nextExpectedAt":"2026-10-23T11:00:00Z"},
  {"id":"m-ent","name":"paid-feature: entitlement","status":"CRON_MONITOR_STATUS_HEALTHY","paused":true,"armed":false},
  {"id":"m-gates","name":"paid-feature: gates","status":"CRON_MONITOR_STATUS_WAITING","paused":false,"armed":false},
  {"id":"m-news","name":"shorted-news","status":"CRON_MONITOR_STATUS_HEALTHY","paused":false,"armed":true}
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
	if !out.Configured || len(out.Features) != 3 {
		t.Fatalf("configured %v, features %+v; want three paid-feature monitors and nothing else", out.Configured, out.Features)
	}
	chat, ent, gates := out.Features[0], out.Features[1], out.Features[2]
	// gates is not paused, yet it has never checked in: it is not armed. The old
	// rule (armed = not paused) said it was, and would alert on a run it never made.
	if gates.Feature != "gates" || gates.Armed || gates.Paused {
		t.Errorf("gates = %+v: an unpaused monitor that has never checked in is not armed", gates)
	}
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
	if detail := sourceDetail(out.Sources, "telesis_cron_monitors"); err != nil || len(out.Features) != 0 || !strings.Contains(detail, "TELESIS_SERVICE_ID") || !strings.Contains(detail, "has not reported") {
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

// blockingProbeWeb answers the paid-probe route only when release is closed. Each
// run that reaches the route is announced on started, so a test knows a run is in
// flight before it makes the second call.
func blockingProbeWeb(t *testing.T, started chan<- struct{}, release <-chan struct{}) *adminWebClient {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/internal/paid-probe" {
			http.NotFound(w, r)
			return
		}
		started <- struct{}{}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		_, _ = io.WriteString(w, passingProbe)
	}))
	t.Cleanup(srv.Close)
	return &adminWebClient{checkURL: srv.URL + "/api/internal/admin-check", secret: billingTestSecret, client: srv.Client()}
}

// A second probe while one is in flight is refused at once, as a result, and the
// web app sees one run, not two.
func TestSecondConcurrentProbeIsRefusedAtOnce(t *testing.T) {
	started := make(chan struct{}, 4)
	release := make(chan struct{})
	src := &adminMCPSource{web: blockingProbeWeb(t, started, release)}

	type answer struct {
		out *mcp.PaidProbeOutput
		err error
	}
	first := make(chan answer, 1)
	go func() {
		out, err := src.RunPaidProbe(context.Background())
		first <- answer{out, err}
	}()
	<-started // the first run has reached the web app

	begin := time.Now()
	out, err := src.RunPaidProbe(context.Background())
	if err != nil || out == nil || !out.InProgress {
		t.Fatalf("second call: out %+v, err %v; want an in-progress result, not an error", out, err)
	}
	if waited := time.Since(begin); waited > 2*time.Second {
		t.Fatalf("second call waited %s; a refusal must not queue behind the first run", waited)
	}
	if len(started) != 0 {
		t.Fatalf("the second call reached the web app (%d runs announced)", len(started))
	}

	close(release)
	got := <-first
	if got.err != nil || got.out == nil || !got.out.OK {
		t.Fatalf("first run: out %+v, err %v; want the passing report", got.out, got.err)
	}
}

// The guard is released when a run ends, so the next probe runs.
func TestGuardIsReleasedWhenTheRunEnds(t *testing.T) {
	started := make(chan struct{}, 4)
	release := make(chan struct{})
	close(release)
	src := &adminMCPSource{web: blockingProbeWeb(t, started, release)}
	for i := range 2 {
		out, err := src.RunPaidProbe(context.Background())
		if err != nil || out == nil || out.InProgress || !out.OK {
			t.Fatalf("run %d: out %+v, err %v; want a finished passing run", i, out, err)
		}
	}
	if src.probing.Load() {
		t.Fatal("the guard is still held after the runs finished")
	}
}

// A cancelled call releases the guard too: a run that the caller abandoned must not
// block every later probe.
func TestGuardIsReleasedWhenTheCallIsCancelled(t *testing.T) {
	started := make(chan struct{}, 4)
	release := make(chan struct{})
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
	})
	src := &adminMCPSource{web: blockingProbeWeb(t, started, release)}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := src.RunPaidProbe(ctx)
		done <- err
	}()
	<-started
	cancel()
	if err := <-done; err == nil {
		t.Fatal("a cancelled probe returned no error")
	}
	if src.probing.Load() {
		t.Fatal("the guard is still held after the caller cancelled")
	}
}

// The run is bounded by the context it is given, so a caller's deadline is the
// deadline that applies.
func TestRunPaidProbeIsBoundedByItsContext(t *testing.T) {
	started := make(chan struct{}, 4)
	release := make(chan struct{})
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
	})
	src := &adminMCPSource{web: blockingProbeWeb(t, started, release)}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	begin := time.Now()
	if _, err := src.RunPaidProbe(ctx); err == nil {
		t.Fatal("a probe past its deadline returned no error")
	}
	if elapsed := time.Since(begin); elapsed > 5*time.Second {
		t.Fatalf("the probe ran %s past a 150ms deadline", elapsed)
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

// The web app refuses a request it cannot authenticate with 401 or 403. Both are
// the secret being rejected, so both name it, on every route.
func TestWebRoutesTreatAForbiddenSecretLikeAnUnauthorisedOne(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		web := &billingWeb{billingStatus: status, probeStatus: status}
		srv := httptest.NewServer(web)
		t.Cleanup(srv.Close)
		c := &adminWebClient{checkURL: srv.URL + "/api/internal/admin-check", secret: billingTestSecret, client: srv.Client()}

		_, err := c.customer(context.Background(), webBillingRequest{Action: "customer", Email: "ada@example.com"})
		if err == nil || !strings.Contains(err.Error(), "rejected INTERNAL_SERVICE_SECRET") || !strings.Contains(err.Error(), "HTTP "+strconv.Itoa(status)) {
			t.Fatalf("billing %d: err = %v, want the rejected secret named with the status", status, err)
		}
		if _, _, err := c.runPaidProbe(context.Background()); err == nil || !strings.Contains(err.Error(), "rejected INTERNAL_SERVICE_SECRET") {
			t.Fatalf("probe %d: err = %v, want the rejected secret named", status, err)
		}
	}
}
