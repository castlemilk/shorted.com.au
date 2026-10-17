package jobmonitor

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const testTelesisToken = "upk_0123456789abcdef"

func TestTelesisClientListsMonitorsAcrossPages(t *testing.T) {
	var bodies []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/uptimeapi.v1.CronMonitorService/ListCronMonitors" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer "+testTelesisToken {
			t.Errorf("authorization = %q", got)
		}
		if r.Header.Get("Connect-Protocol-Version") != "1" || r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("not a Connect JSON request: %v", r.Header)
		}
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		bodies = append(bodies, body)
		if len(bodies) == 1 {
			_, _ = io.WriteString(w, `{"monitors":[{"id":"m1","name":"shorted-news","status":"CRON_MONITOR_STATUS_HEALTHY","lastRunAt":"2026-10-17T00:00:05Z","nextExpectedAt":"2026-10-17T04:00:00Z"}],"pageInfo":{"nextPageToken":"100","hasNextPage":true}}`)
			return
		}
		_, _ = io.WriteString(w, `{"monitors":[{"id":"m2","name":"shorted-economy","status":"CRON_MONITOR_STATUS_FAILING","paused":true}],"pageInfo":{}}`)
	}))
	defer srv.Close()

	c := newTelesisClient(TelesisConfig{BaseURL: srv.URL + "/", Token: testTelesisToken, OrgID: "org-1", ServiceID: "svc-1"})
	got, err := c.ListCronMonitors(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Status != "healthy" || got[0].NextExpectedAt != "2026-10-17T04:00:00Z" || got[1].Status != "failing" || !got[1].Paused {
		t.Fatalf("monitors = %+v", got)
	}
	if len(bodies) != 2 || bodies[0]["orgId"] != "org-1" || bodies[0]["serviceId"] != "svc-1" {
		t.Fatalf("requests = %v, want orgId and serviceId on each", bodies)
	}
	if page := bodies[1]["page"].(map[string]any); page["pageToken"] != "100" || page["pageSize"] != float64(100) {
		t.Errorf("second page = %v, want the returned token", page)
	}
}

// protojson writes int64 as a quoted string; a bare number must decode too.
func TestTelesisClientDecodesRuns(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(raw), `"cronMonitorId":"m1"`) || !strings.Contains(string(raw), `"pageSize":20`) {
			t.Errorf("body = %s", raw)
		}
		_, _ = io.WriteString(w, `{"runs":[
			{"runId":"shorted-news-1","status":"CRON_RUN_STATUS_TIMED_OUT","startedAt":"2026-10-17T00:00:05Z","durationMs":"3600000","exitCode":137,"terminalReason":"deadline exceeded"},
			{"runId":"shorted-news-0","status":"CRON_RUN_STATUS_SUCCEEDED","durationMs":42}]}`)
	}))
	defer srv.Close()

	c := newTelesisClient(TelesisConfig{BaseURL: srv.URL, Token: testTelesisToken, OrgID: "org-1"})
	runs, err := c.ListCronRuns(context.Background(), "m1", 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 2 || runs[0].Status != "timed_out" || runs[0].DurationMs != 3600000 || runs[0].ExitCode == nil || *runs[0].ExitCode != 137 ||
		runs[0].TerminalReason != "deadline exceeded" || runs[1].DurationMs != 42 {
		t.Fatalf("runs = %+v", runs)
	}
}

// A refusal names Telesis' own code and never the token.
func TestTelesisClientReportsConnectErrorsWithoutTheToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, `{"code":"permission_denied","message":"organization access required"}`)
	}))
	defer srv.Close()

	c := newTelesisClient(TelesisConfig{BaseURL: srv.URL, Token: testTelesisToken, OrgID: "org-1"})
	_, err := c.ListCronMonitors(context.Background())
	if err == nil || !strings.Contains(err.Error(), "permission_denied: organization access required") {
		t.Fatalf("err = %v", err)
	}
	if strings.Contains(err.Error(), testTelesisToken) {
		t.Fatal("the error carries the token")
	}
}

func TestTelesisIsOptional(t *testing.T) {
	t.Setenv("TELESIS_API_TOKEN", "")
	t.Setenv("TELESIS_ORG_ID", "")
	t.Setenv("TELESIS_API_URL", "")
	cfg := TelesisConfigFromEnv()
	if cfg.Enabled() || cfg.BaseURL != "https://api.telesis.dev" {
		t.Fatalf("cfg = %+v, want disabled with the default URL", cfg)
	}
	if state, _ := NewCollector(Config{Telesis: cfg}).ClusterMonitoring(); state != "unconfigured" {
		t.Errorf("state = %s, want unconfigured", state)
	}

	t.Setenv("TELESIS_API_TOKEN", testTelesisToken)
	t.Setenv("TELESIS_ORG_ID", "org-1")
	c := NewCollector(Config{Telesis: TelesisConfigFromEnv()})
	if state, _ := c.ClusterMonitoring(); state != "available" || c.cron == nil {
		t.Errorf("state = %s, want a configured Telesis source", state)
	}
}
