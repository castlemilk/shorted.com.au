package brandbrain

// fleet.go is the admin MCP's second BrandBrain client: the fleet routes the housing
// crawl debugging tools read, plus the two rig commands the smoke loop sends. It is
// as narrow as the grant client (client.go), and shares its rules:
//
//   - the base URL is the same pinned https://api.brandbrain.dev (ValidateBaseURL);
//   - redirects are refused, so the token never travels to another host;
//   - every request has the same hard timeout;
//   - outcomes are typed, and a command whose outcome is not known is ErrUnavailable,
//     which the caller reports as unknown and never retries on its own;
//   - the token is sent only in its header and never appears in an error or a return.
//
// It talks to these routes and no others:
//
//	GET  /api/v1/fleet/rigs
//	GET  /api/v1/fleet/rigs/{id}                 (carries server_time)
//	GET  /api/v1/fleet/rigs/{id}/commands
//	POST /api/v1/fleet/rigs/{id}/commands        (two kinds only, see RequestRuntimeLogs and RunDrain)
//	GET  /api/v1/fleet/crawl-jobs
//
// The token is a separate credential from the grant token (BRANDBRAIN_FLEET_OPS_TOKEN,
// header X-Fleet-Ops-Token). Every request also names the verified admin in
// X-Fleet-Operator, for BrandBrain's audit log.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	// EnvFleetOpsToken carries the fleet credential. Unset means the crawl debugging
	// tools report themselves as not configured and send nothing.
	EnvFleetOpsToken = "BRANDBRAIN_FLEET_OPS_TOKEN"

	fleetTokenHeader    = "X-Fleet-Ops-Token"
	fleetOperatorHeader = "X-Fleet-Operator"
	idempotencyHeader   = "Idempotency-Key"

	// fleetMaxResponseBytes bounds a fleet read. A page of 200 crawl jobs is well under
	// this; anything larger is not that contract.
	fleetMaxResponseBytes = 1 << 20

	// Rig command kinds. These are the only two the client can send.
	CommandCollectRuntimeLogs = "collect_runtime_logs"
	CommandHousingCrawlRun    = "housing_crawl_run"
	// LogSourceHousing and LogSourceRuntime are the two logs collect_runtime_logs reads.
	LogSourceHousing = "housing"
	LogSourceRuntime = "runtime"
	// DrainJob is the only job housing_crawl_run may name.
	DrainJob = "drain"
)

// ErrCommandRefused means the client refused to build a command it was not asked to
// send (an unknown log source). Nothing was sent.
var ErrCommandRefused = errors.New("command_refused")

// FleetClient calls the fleet routes. Build it with FleetFromEnv, or WithOperator to
// name the admin on a request.
type FleetClient struct {
	c        *Client
	operator string
}

// FleetFromEnv builds the fleet client. It returns (nil, nil) when BRANDBRAIN_FLEET_OPS_TOKEN
// is unset, so the caller reports the tools as not configured. The base URL is the grant
// client's (BRANDBRAIN_API_URL), and is refused unless it is the pinned host.
func FleetFromEnv(getenv func(string) string) (*FleetClient, error) {
	token := strings.TrimSpace(getenv(EnvFleetOpsToken))
	if token == "" {
		return nil, nil
	}
	base := strings.TrimSpace(getenv(EnvBaseURL))
	if base == "" {
		base = DefaultBaseURL
	}
	u, err := ValidateBaseURL(base)
	if err != nil {
		return nil, err
	}
	return &FleetClient{c: newClient(u, token, DefaultTimeout)}, nil
}

// NewFleetTestClient is the test hook: a client against a loopback http stand-in.
// Nothing in production calls it.
func NewFleetTestClient(baseURL, token string, timeout time.Duration) (*FleetClient, error) {
	c, err := NewTestClient(baseURL, token, timeout)
	if err != nil {
		return nil, err
	}
	return &FleetClient{c: c}, nil
}

// WithOperator returns a copy of the client that names operator (an admin's verified
// address) in X-Fleet-Operator as shorted-admin:<operator>. An empty operator sends no header.
func (f *FleetClient) WithOperator(operator string) *FleetClient {
	if f == nil {
		return nil
	}
	cp := *f
	cp.operator = strings.TrimSpace(operator)
	return &cp
}

// Rig is one rig as the fleet lists it. Only the fields the crawl tools read are kept.
type Rig struct {
	ID              string       `json:"id"`
	Version         string       `json:"version"`
	Liveness        string       `json:"liveness"`
	LastHeartbeatAt *time.Time   `json:"last_heartbeat_at"`
	Resources       RigResources `json:"resources"`
}

// RigResources wraps the housing crawl's self-report.
type RigResources struct {
	HousingCrawl HousingCrawl `json:"housing_crawl"`
}

// HousingCrawl is a rig's housing crawl state. The fleet's circuit list is not decoded:
// the crawl tools report portals, not breaker internals. Alarm has no fixed shape in the
// contract, so it is kept as decoded JSON and reduced to closed values by the caller.
type HousingCrawl struct {
	State    string     `json:"state"`
	Env      CrawlEnv   `json:"env"`
	Portals  []Portal   `json:"portals"`
	InFlight *InFlight  `json:"in_flight"`
	Jobs     CrawlJobs  `json:"jobs"`
	Alarm    any        `json:"alarm"`
	Ingest   IngestInfo `json:"ingest"`
}

// CrawlEnv is the rig's Chrome and driver versions.
type CrawlEnv struct {
	Chrome string `json:"chrome"`
	Driver string `json:"driver"`
}

// Portal is one portal's breaker state on a rig.
type Portal struct {
	Source             string     `json:"source"`
	State              string     `json:"state"`
	ConsecutiveBlocked int        `json:"consecutive_blocked"`
	BackoffS           int        `json:"backoff_s"`
	OpenUntil          *time.Time `json:"open_until"`
	UpdatedAt          *time.Time `json:"updated_at"`
}

// InFlight is the job a rig is running now.
type InFlight struct {
	Job            string     `json:"job"`
	Phase          string     `json:"phase"`
	Round          int        `json:"round"`
	LastProgressAt *time.Time `json:"last_progress_at"`
	Counts         Counts     `json:"counts"`
}

// Counts are a drain's or an in-flight job's tallies.
type Counts struct {
	Claimed   int `json:"claimed"`
	Succeeded int `json:"succeeded"`
	Failed    int `json:"failed"`
	Deferred  int `json:"deferred"`
	Blocked   int `json:"blocked"`
	Listings  int `json:"listings"`
}

// CrawlJobs holds the rig's job schedules.
type CrawlJobs struct {
	Drain DrainSchedule `json:"drain"`
}

// DrainSchedule is the rig's drain: whether it runs, when next, and the last run.
type DrainSchedule struct {
	Enabled   bool       `json:"enabled"`
	NextRunAt *time.Time `json:"next_run_at"`
	RetryAt   *time.Time `json:"retry_at"`
	Last      *DrainRun  `json:"last"`
}

// DrainRun is the outcome of one drain.
type DrainRun struct {
	Outcome    string     `json:"outcome"`
	ExitCode   int        `json:"exit_code"`
	FinishedAt *time.Time `json:"finished_at"`
	Counts     Counts     `json:"counts"`
}

// IngestInfo is the rig's last push probe.
type IngestInfo struct {
	Probe         string     `json:"probe"`
	LastOKAt      *time.Time `json:"last_ok_at"`
	LastErrorCode string     `json:"last_error_code"`
}

// RigDetail is one rig plus the server's clock. The clock is what makes a portal's
// open_until mean something: a breaker is open only while open_until is in the future.
type RigDetail struct {
	Rig
	ServerTime *time.Time `json:"server_time"`
}

// Command is one command sent to a rig.
type Command struct {
	ID         string      `json:"id"`
	Kind       string      `json:"kind"`
	Status     string      `json:"status"`
	ResultData *ResultData `json:"result_data"`
	CreatedAt  *time.Time  `json:"created_at"`
}

// ResultData carries a command's result. Only the runtime log text is kept.
type ResultData struct {
	RuntimeLogs *RuntimeLogs `json:"runtime_logs"`
}

// RuntimeLogs is the text a collect_runtime_logs command returned.
type RuntimeLogs struct {
	Text string `json:"text"`
}

// CrawlJob is one BrandBrain crawl job. Its error and result text is returned as the
// fleet sends it; the admin tools decide what reaches the model.
type CrawlJob struct {
	ID            string          `json:"id"`
	Kind          string          `json:"kind"`
	Suburb        string          `json:"suburb"`
	State         string          `json:"state"`
	Postcode      string          `json:"postcode"`
	Source        string          `json:"source"`
	Tier          string          `json:"tier"`
	Priority      int             `json:"priority"`
	Status        string          `json:"status"`
	AssignedAgent string          `json:"assigned_agent"`
	Attempts      int             `json:"attempts"`
	MaxAttempts   int             `json:"max_attempts"`
	ErrorMessage  string          `json:"error_message"`
	ResultSummary json.RawMessage `json:"result_summary"`
	CreatedAt     *time.Time      `json:"created_at"`
	UpdatedAt     *time.Time      `json:"updated_at"`
	StartedAt     *time.Time      `json:"started_at"`
	CompletedAt   *time.Time      `json:"completed_at"`
	NotBefore     *time.Time      `json:"not_before"`
}

// CrawlJobsPage is one page of crawl jobs with the queue summary.
type CrawlJobsPage struct {
	Jobs    []CrawlJob      `json:"jobs"`
	Summary CrawlJobSummary `json:"summary"`
}

// CrawlJobSummary counts jobs by status and source.
type CrawlJobSummary struct {
	ByStatusSource []StatusSourceCount `json:"by_status_source"`
}

// StatusSourceCount is one cell of the summary.
type StatusSourceCount struct {
	Status string `json:"status"`
	Source string `json:"source"`
	Count  int    `json:"count"`
}

// CrawlJobQuery filters the crawl-jobs list. Zero fields are not sent.
type CrawlJobQuery struct {
	ID            string
	Status        string
	Source        string
	Kind          string
	AssignedAgent string
	UpdatedSince  string // RFC 3339
	Limit         int    // 0 sends no limit
}

// ListRigs returns every rig the fleet knows.
func (f *FleetClient) ListRigs(ctx context.Context) ([]Rig, error) {
	var out struct {
		Rigs []Rig `json:"rigs"`
	}
	if err := f.call(ctx, http.MethodGet, "/api/v1/fleet/rigs", nil, nil, "", &out); err != nil {
		return nil, err
	}
	return out.Rigs, nil
}

// GetRig returns one rig with the server's clock.
func (f *FleetClient) GetRig(ctx context.Context, rigID string) (*RigDetail, error) {
	path, err := rigPath(rigID)
	if err != nil {
		return nil, err
	}
	var out RigDetail
	if err := f.call(ctx, http.MethodGet, path, nil, nil, "", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListRigCommands returns a rig's recent commands, newest first as the fleet orders them.
func (f *FleetClient) ListRigCommands(ctx context.Context, rigID string) ([]Command, error) {
	path, err := rigPath(rigID)
	if err != nil {
		return nil, err
	}
	var out struct {
		Commands []Command `json:"commands"`
	}
	if err := f.call(ctx, http.MethodGet, path+"/commands", nil, nil, "", &out); err != nil {
		return nil, err
	}
	return out.Commands, nil
}

// ListCrawlJobs reads one page of crawl jobs and the queue summary.
func (f *FleetClient) ListCrawlJobs(ctx context.Context, q CrawlJobQuery) (*CrawlJobsPage, error) {
	v := url.Values{}
	set := func(k, s string) {
		if s != "" {
			v.Set(k, s)
		}
	}
	set("id", q.ID)
	set("status", q.Status)
	set("source", q.Source)
	set("kind", q.Kind)
	set("assigned_agent", q.AssignedAgent)
	set("updated_since", q.UpdatedSince)
	if q.Limit > 0 {
		v.Set("limit", strconv.Itoa(q.Limit))
	}
	var out CrawlJobsPage
	if err := f.call(ctx, http.MethodGet, "/api/v1/fleet/crawl-jobs", v, nil, "", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RequestRuntimeLogs asks a rig for its logs. source is housing or runtime. The fleet
// answers with the command; its result arrives later on the rig's command list. idemKey
// makes a retry return the same command rather than a second one.
func (f *FleetClient) RequestRuntimeLogs(ctx context.Context, rigID, source, idemKey string) (*Command, error) {
	if source != LogSourceHousing && source != LogSourceRuntime {
		return nil, ErrCommandRefused
	}
	return f.command(ctx, rigID, CommandCollectRuntimeLogs, map[string]string{"source": source}, idemKey)
}

// RunDrain asks a rig to run its housing drain now, once, with dry_run false.
func (f *FleetClient) RunDrain(ctx context.Context, rigID, idemKey string) (*Command, error) {
	return f.command(ctx, rigID, CommandHousingCrawlRun, map[string]any{"job": DrainJob, "dry_run": false}, idemKey)
}

func (f *FleetClient) command(ctx context.Context, rigID, kind string, payload any, idemKey string) (*Command, error) {
	if f == nil || f.c == nil {
		return nil, ErrNotConfigured
	}
	path, err := rigPath(rigID)
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(struct {
		Kind    string `json:"kind"`
		Payload any    `json:"payload"`
	}{Kind: kind, Payload: payload})
	if err != nil {
		return nil, ErrInvalidRequest
	}
	var out Command
	if err := f.call(ctx, http.MethodPost, path+"/commands", nil, body, idemKey, &out); err != nil {
		return nil, err
	}
	if out.ID == "" {
		// A 2xx with no command id cannot be followed up. The outcome is not known.
		return nil, ErrUnavailable
	}
	return &out, nil
}

// rigIDPattern is BrandBrain's rig id shape. Anything else is refused before a request is
// built, so a rig id can never add a path segment or a query to the route.
var rigIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`)

func rigPath(rigID string) (string, error) {
	if !rigIDPattern.MatchString(rigID) {
		return "", ErrInvalidRequest
	}
	return "/api/v1/fleet/rigs/" + rigID, nil
}

func (f *FleetClient) call(ctx context.Context, method, path string, query url.Values, body []byte, idemKey string, out any) error {
	if f == nil || f.c == nil {
		return ErrNotConfigured
	}
	endpoint := *f.c.base
	endpoint.Path = path
	if query != nil {
		endpoint.RawQuery = query.Encode()
	}
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint.String(), reader)
	if err != nil {
		return ErrInvalidRequest
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set(fleetTokenHeader, f.c.token)
	if f.operator != "" && !strings.ContainsAny(f.operator, "\r\n") {
		req.Header.Set(fleetOperatorHeader, "shorted-admin:"+f.operator)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if idemKey != "" {
		req.Header.Set(idempotencyHeader, idemKey)
	}

	resp, err := f.c.http.Do(req)
	if err != nil {
		// A timeout, a refused redirect or a dropped connection: the outcome is not known.
		return ErrUnavailable
	}
	defer func() { _ = resp.Body.Close() }()
	raw, readErr := io.ReadAll(io.LimitReader(resp.Body, fleetMaxResponseBytes))

	switch resp.StatusCode {
	case http.StatusOK, http.StatusCreated, http.StatusAccepted:
		if out == nil {
			return nil
		}
		if readErr != nil || json.Unmarshal(raw, out) != nil {
			return ErrUnavailable
		}
		return nil
	case http.StatusNotFound:
		if isRigNotFoundBody(raw) {
			return ErrRigNotFound
		}
		return ErrUnavailable
	case http.StatusBadRequest:
		return ErrInvalidRequest
	case http.StatusUnauthorized, http.StatusForbidden:
		return ErrRejected
	default:
		return ErrUnavailable
	}
}
