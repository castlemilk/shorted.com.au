package jobmonitor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ErrCronUnconfigured reports that no Telesis token or organization is set, so
// no cron monitor can be read at all. It is a state, not a failure.
var ErrCronUnconfigured = errors.New("telesis cron monitors are not configured")

// CronMonitorHistory is one cron monitor with its newest runs. RunsErr is set
// when the run history could not be read; Runs is then empty and must not be
// taken for a clean history.
type CronMonitorHistory struct {
	Monitor CronMonitor
	Runs    []CronRun
	RunsErr error
}

// CronMonitorsNamed returns the Telesis cron monitors whose names start with
// prefix, sorted by name, each with its newest `runs` runs. A monitor list that
// cannot be read is the error; a run history that cannot be read is reported on
// its own entry, so one bad monitor does not hide the others.
func (c *Collector) CronMonitorsNamed(ctx context.Context, prefix string, runs int) ([]CronMonitorHistory, error) {
	if c == nil || c.cron == nil {
		return nil, ErrCronUnconfigured
	}
	monitors, err := c.cron.ListCronMonitors(ctx)
	if err != nil {
		return nil, fmt.Errorf("telesis cron monitors unavailable: %w", err)
	}
	var out []CronMonitorHistory
	for _, m := range monitors {
		if strings.HasPrefix(m.Name, prefix) {
			out = append(out, CronMonitorHistory{Monitor: m})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Monitor.Name < out[j].Monitor.Name })
	for i := range out {
		out[i].Runs, out[i].RunsErr = c.cron.ListCronRuns(ctx, out[i].Monitor.ID, runs)
	}
	return out, nil
}

// TelesisConfig points the collector at the Telesis cron monitors that
// cronjob-reporter keeps for every scheduled job. The token is a Telesis
// project token (upk_...) with the read role, scoped to ServiceID: the
// "shorted.com.au scheduled jobs" service the monitors hang on
// (deploy/kubernetes/jobs/scripts/register-monitors.py).
type TelesisConfig struct {
	BaseURL   string
	Token     string
	OrgID     string
	ServiceID string // optional; required when the token is scoped
}

// Enabled reports whether there is enough to call Telesis at all.
func (c TelesisConfig) Enabled() bool {
	return c.Token != "" && c.OrgID != ""
}

// TelesisConfigFromEnv reads TELESIS_API_TOKEN, TELESIS_ORG_ID,
// TELESIS_SERVICE_ID and TELESIS_API_URL (default https://api.telesis.dev).
func TelesisConfigFromEnv() TelesisConfig {
	return TelesisConfig{
		BaseURL:   firstNonEmpty(strings.TrimSpace(os.Getenv("TELESIS_API_URL")), "https://api.telesis.dev"),
		Token:     strings.TrimSpace(os.Getenv("TELESIS_API_TOKEN")),
		OrgID:     strings.TrimSpace(os.Getenv("TELESIS_ORG_ID")),
		ServiceID: strings.TrimSpace(os.Getenv("TELESIS_SERVICE_ID")),
	}
}

// telesisClient speaks Connect's JSON protocol to the Telesis API.
type telesisClient struct {
	cfg  TelesisConfig
	http *http.Client
}

func newTelesisClient(cfg TelesisConfig) *telesisClient {
	cfg.BaseURL = strings.TrimRight(cfg.BaseURL, "/")
	return &telesisClient{cfg: cfg, http: &http.Client{Timeout: 10 * time.Second}}
}

// maxTelesisResponseBytes bounds one response. Twenty runs carry at most
// twenty 16KiB diagnostic excerpts, so a run page is the largest by far.
const maxTelesisResponseBytes = 1 << 20

type telesisPage struct {
	PageSize  int32  `json:"pageSize"`
	PageToken string `json:"pageToken,omitempty"`
}

type telesisPageInfo struct {
	NextPageToken string `json:"nextPageToken"`
	HasNextPage   bool   `json:"hasNextPage"`
}

type telesisMonitor struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	Status         string          `json:"status"`
	Paused         bool            `json:"paused"`
	Armed          bool            `json:"armed"`
	Schedule       telesisSchedule `json:"schedule"`
	LastRunAt      string          `json:"lastRunAt"`
	NextExpectedAt string          `json:"nextExpectedAt"`
}

// telesisSchedule carries a monitor's cadence. Only the cron form is read: an
// interval monitor has no cron expression and reads as "" here.
type telesisSchedule struct {
	CronExpression string `json:"cronExpression"`
}

type telesisRun struct {
	RunID          string     `json:"runId"`
	Status         string     `json:"status"`
	ExpectedAt     string     `json:"expectedAt"`
	StartedAt      string     `json:"startedAt"`
	EndedAt        string     `json:"endedAt"`
	DurationMs     protoInt64 `json:"durationMs"`
	ExitCode       *int       `json:"exitCode"`
	TerminalReason string     `json:"terminalReason"`
}

// protoInt64 decodes an int64 as protojson writes it (a quoted string) or as a
// bare number.
type protoInt64 int64

func (v *protoInt64) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		*v = 0
		return nil
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return err
	}
	*v = protoInt64(n)
	return nil
}

func (c *telesisClient) ListCronMonitors(ctx context.Context) ([]CronMonitor, error) {
	type request struct {
		OrgID     string      `json:"orgId"`
		ServiceID string      `json:"serviceId,omitempty"`
		Page      telesisPage `json:"page"`
	}
	type response struct {
		Monitors []telesisMonitor `json:"monitors"`
		PageInfo telesisPageInfo  `json:"pageInfo"`
	}
	var out []CronMonitor
	token := ""
	// A page cap keeps a misbehaving cursor from looping forever; 20 pages of
	// 100 is far past one service's monitors.
	for range 20 {
		var resp response
		req := request{OrgID: c.cfg.OrgID, ServiceID: c.cfg.ServiceID, Page: telesisPage{PageSize: 100, PageToken: token}}
		if err := c.call(ctx, "CronMonitorService/ListCronMonitors", req, &resp); err != nil {
			return nil, err
		}
		for _, m := range resp.Monitors {
			out = append(out, CronMonitor{
				ID: m.ID, Name: m.Name, Status: enumSuffix(m.Status, "CRON_MONITOR_STATUS_"),
				Paused: m.Paused, Armed: m.Armed, Schedule: m.Schedule.CronExpression,
				LastRunAt: m.LastRunAt, NextExpectedAt: m.NextExpectedAt,
			})
		}
		if !resp.PageInfo.HasNextPage || resp.PageInfo.NextPageToken == "" {
			return out, nil
		}
		token = resp.PageInfo.NextPageToken
	}
	return out, nil
}

func (c *telesisClient) ListCronRuns(ctx context.Context, monitorID string, limit int) ([]CronRun, error) {
	type request struct {
		CronMonitorID string      `json:"cronMonitorId"`
		Page          telesisPage `json:"page"`
	}
	type response struct {
		Runs []telesisRun `json:"runs"`
	}
	var resp response
	if err := c.call(ctx, "CronMonitorService/ListCronRuns", request{
		CronMonitorID: monitorID, Page: telesisPage{PageSize: int32(limit)},
	}, &resp); err != nil {
		return nil, err
	}
	out := make([]CronRun, 0, len(resp.Runs))
	for _, r := range resp.Runs {
		out = append(out, CronRun{
			RunID: r.RunID, Status: enumSuffix(r.Status, "CRON_RUN_STATUS_"),
			ExpectedAt: r.ExpectedAt, StartedAt: r.StartedAt, EndedAt: r.EndedAt,
			DurationMs: int64(r.DurationMs), ExitCode: r.ExitCode, TerminalReason: r.TerminalReason,
		})
	}
	return out, nil
}

// call POSTs one Connect unary request. Errors name the method and Telesis'
// own code and message, never the token.
func (c *telesisClient) call(ctx context.Context, method string, in, out any) error {
	body, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.BaseURL+"/uptimeapi.v1."+method, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Connect-Protocol-Version", "1")
	req.Header.Set("User-Agent", "shorted-jobmonitor/1.0 (+https://shorted.com.au)")
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("telesis %s: %w", method, err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxTelesisResponseBytes))
	if err != nil {
		return fmt.Errorf("telesis %s: read: %w", method, err)
	}
	if resp.StatusCode != http.StatusOK {
		var connectErr struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		if json.Unmarshal(raw, &connectErr) == nil && connectErr.Code != "" {
			return fmt.Errorf("telesis %s: %s: %s", method, connectErr.Code, connectErr.Message)
		}
		return fmt.Errorf("telesis %s: HTTP %d", method, resp.StatusCode)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("telesis %s: decode: %w", method, err)
	}
	return nil
}

// enumSuffix turns CRON_RUN_STATUS_TIMED_OUT into timed_out.
func enumSuffix(value, prefix string) string {
	return strings.ToLower(strings.TrimPrefix(value, prefix))
}
