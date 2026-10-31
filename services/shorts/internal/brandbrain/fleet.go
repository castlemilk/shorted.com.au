package brandbrain

// fleet.go is the admin MCP's second BrandBrain client: the fleet routes the housing crawl
// debugging tools read, plus the two rig commands the smoke loop sends. It is as narrow as the
// grant client (client.go), and shares its rules: the pinned https://api.brandbrain.dev host, no
// redirects, a hard timeout, typed outcomes, and a token that is never returned or logged.
//
// The shapes decoded here are BrandBrain's, from the handlers on origin/main at 780a11b5
// (backend/internal/adapters/http): fleet_handler.go (handleListRigs, handleGetRig),
// fleet_orchestration_handler.go (handleCreateCommand, handleListRigCommands, writeCommands),
// fleet_crawl_jobs_admin.go (handleListFleetCrawlJobs) and domain/housing_crawl_heartbeat.go.
// fleet_contract_test.go pins them. A change on BrandBrain's side must change that test first.
//
// The ops token may open exactly these routes (fleet_ops_token.go, fleetOpsRoutes):
//
//	GET  /api/v1/fleet/rigs                       list, with server_time
//	GET  /api/v1/fleet/rigs/{id}                  one rig, with server_time (not used here)
//	GET  /api/v1/fleet/rigs/{id}/commands         list, or one command with ?request_key=
//	GET  /api/v1/fleet/crawl-jobs                 housing only
//	POST /api/v1/fleet/rigs/{id}/commands         collect_runtime_logs, or a LIVE housing_crawl_run drain

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
	// EnvFleetOpsToken carries the fleet credential. Unset means the crawl debugging tools report
	// themselves as not configured and send nothing.
	EnvFleetOpsToken = "BRANDBRAIN_FLEET_OPS_TOKEN"

	fleetTokenHeader    = "X-Fleet-Ops-Token"
	fleetOperatorHeader = "X-Fleet-Operator"
	idempotencyHeader   = "Idempotency-Key"

	// fleetMaxResponseBytes bounds a fleet read. A command list of 50 entries with runtime logs
	// is far under this; anything larger is not that contract.
	fleetMaxResponseBytes = 1 << 20

	// Rig command kinds. These are the only two the client can send.
	CommandCollectRuntimeLogs = "collect_runtime_logs"
	CommandHousingCrawlRun    = "housing_crawl_run"
	// LogSourceHousing and LogSourceRuntime are the two logs collect_runtime_logs reads.
	LogSourceHousing = "housing"
	LogSourceRuntime = "runtime"
	// DrainJob is the only job housing_crawl_run may name.
	DrainJob = "drain"
	// CrawlKind is the only job kind the ops token may read (fleetCrawlJobsDefaultKind).
	CrawlKind = "housing"
)

// ErrCommandRefused means the client refused to build a command it was not asked to send (an
// unknown log source). Nothing was sent.
var ErrCommandRefused = errors.New("command_refused")

// ErrRateLimited means BrandBrain's per-rig live limit was reached (429). Nothing was created. It
// says nothing about the crawl.
var ErrRateLimited = errors.New("rate_limited")

// ErrCommandNotFound is a 404 from the request-key lookup: no command has that key, so nothing was
// created under it. It is a definite answer, not an unknown outcome.
var ErrCommandNotFound = errors.New("command_not_found")

// ErrConflict is a 409 from BrandBrain. Nothing was created. The code says why (see ConflictError).
var ErrConflict = errors.New("conflict")

// ConflictError is a 409 with BrandBrain's closed code: rig_busy, rig_not_active,
// agent_update_required, management_action_unsupported, idempotency_conflict and the others the
// housing command path returns. errors.Is(err, ErrConflict) holds for every one.
type ConflictError struct{ Code string }

func (e *ConflictError) Error() string { return "conflict: " + e.Code }

// Is makes errors.Is(err, ErrConflict) hold for any ConflictError.
func (e *ConflictError) Is(target error) bool { return target == ErrConflict }

var (
	// closedCode is a BrandBrain refusal code. Anything else is not echoed.
	closedCode = regexp.MustCompile(`^[a-z][a-z_]{1,60}$`)
	// requestKeyPattern is BrandBrain's commandRequestKey.
	requestKeyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
)

// FleetClient calls the fleet routes. Build it with FleetFromEnv, or WithOperator to name the admin
// on a request.
type FleetClient struct {
	c        *Client
	operator string
}

// FleetFromEnv builds the fleet client. It returns (nil, nil) when BRANDBRAIN_FLEET_OPS_TOKEN is
// unset. The base URL is the grant client's (BRANDBRAIN_API_URL), refused unless it is the pinned
// host.
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
func NewFleetTestClient(baseURL, token string, timeout time.Duration) (*FleetClient, error) {
	c, err := NewTestClient(baseURL, token, timeout)
	if err != nil {
		return nil, err
	}
	return &FleetClient{c: c}, nil
}

// WithOperator returns a copy that names operator (an admin's verified address) in X-Fleet-Operator
// as shorted-admin:<operator>. An empty operator sends no header.
func (f *FleetClient) WithOperator(operator string) *FleetClient {
	if f == nil {
		return nil
	}
	cp := *f
	cp.operator = strings.TrimSpace(operator)
	return &cp
}

// Rig is one rig as the fleet list returns it (rigDTO, flattened into the list item).
type Rig struct {
	ID              string       `json:"id"`
	Version         string       `json:"version"`
	Liveness        string       `json:"liveness"`
	LastHeartbeatAt *time.Time   `json:"last_heartbeat_at"`
	Resources       RigResources `json:"resources"`
}

// RigResources wraps the housing crawl's self-report. A rig that reports no housing block has a
// nil HousingCrawl, which the tools read as unknown, never as healthy.
type RigResources struct {
	HousingCrawl *HousingCrawl `json:"housing_crawl"`
}

// HousingCrawl is a rig's housing crawl heartbeat (domain.HousingCrawlHeartbeat). Circuit is not
// decoded: the tools report portals, not breaker internals.
type HousingCrawl struct {
	State    string                `json:"state"`
	Env      *CrawlEnv             `json:"env"`
	Portals  []Portal              `json:"portals"`
	InFlight *InFlight             `json:"in_flight"`
	Jobs     map[string]DrainSched `json:"jobs"`
	Ingest   IngestInfo            `json:"ingest"`
}

// CrawlEnv is the rig's Chrome and driver versions.
type CrawlEnv struct {
	Chrome string `json:"chrome"`
	Driver string `json:"driver"`
}

// Portal is one portal's breaker state on a rig (domain.HousingCrawlPortal).
type Portal struct {
	Source             string     `json:"source"`
	State              string     `json:"state"`
	ConsecutiveBlocked int        `json:"consecutive_blocked"`
	BackoffS           int        `json:"backoff_s"`
	OpenUntil          *time.Time `json:"open_until"`
	UpdatedAt          *time.Time `json:"updated_at"`
}

// InFlight is the job a rig is running now (domain.HousingCrawlInFlight).
type InFlight struct {
	Job            string     `json:"job"`
	Phase          string     `json:"phase"`
	Round          int        `json:"round"`
	LastProgressAt *time.Time `json:"last_progress_at"`
	Counts         *Counts    `json:"counts"`
}

// Counts are a drain's or an in-flight job's tallies (domain.HousingCrawlLiveCounts).
type Counts struct {
	Claimed   int `json:"claimed"`
	Succeeded int `json:"succeeded"`
	Failed    int `json:"failed"`
	Deferred  int `json:"deferred"`
	Blocked   int `json:"blocked"`
	Listings  int `json:"listings"`
}

// DrainSched is one job's schedule and last outcome (domain.HousingCrawlJob). The alarm is on the
// last run (HousingCrawlResult.Alarm), not at the top of the heartbeat.
type DrainSched struct {
	Enabled   bool       `json:"enabled"`
	NextRunAt *time.Time `json:"next_run_at"`
	RetryAt   *time.Time `json:"retry_at"`
	Held      string     `json:"held"`
	Last      *DrainRun  `json:"last"`
}

// DrainRun is the outcome of one run (domain.HousingCrawlResult). Counts is a JSON object keyed by
// the tally names; it decodes into Counts by name.
type DrainRun struct {
	Outcome    string     `json:"outcome"`
	ExitCode   int        `json:"exit_code"`
	FinishedAt *time.Time `json:"finished_at"`
	Counts     Counts     `json:"counts"`
	Alarm      string     `json:"alarm"`
}

// IngestInfo is the rig's last push probe (domain.HousingCrawlIngest).
type IngestInfo struct {
	Probe         string     `json:"probe"`
	LastOKAt      *time.Time `json:"last_ok_at"`
	LastErrorCode string     `json:"last_error_code"`
}

// RigList is the rig list and the server's clock. The clock is what makes a portal's open_until
// mean something: a breaker is open only while open_until is in the future. It is nil when the
// response carries none, and then no portal can be judged blocked.
type RigList struct {
	Rigs       []Rig
	ServerTime *time.Time
}

// Command is one command, as the create, replay, request-key and list routes return it
// (rigCommandDTO).
type Command struct {
	ID         string      `json:"id"`
	Kind       string      `json:"kind"`
	RequestKey string      `json:"request_key"`
	Status     string      `json:"status"`
	Result     string      `json:"result"`
	ResultData *ResultData `json:"result_data"`
	CreatedAt  *time.Time  `json:"created_at"`
	ExpiresAt  *time.Time  `json:"expires_at"`
}

// ResultData carries a command's result. Only the runtime log is kept.
type ResultData struct {
	RuntimeLogs *RuntimeLogs `json:"runtime_logs"`
}

// RuntimeLogs is the text a collect_runtime_logs command returned (domain.RigRuntimeLogs).
type RuntimeLogs struct {
	Text      string `json:"text"`
	Truncated bool   `json:"truncated"`
	Redacted  bool   `json:"redacted"`
}

// CommandStatuses are BrandBrain's rig command statuses (domain.RigCommandStatus). A command is
// finished when it is succeeded, failed or expired; pending, delivered and running are not.
const (
	CommandPending   = "pending"
	CommandDelivered = "delivered"
	CommandRunning   = "running"
	CommandSucceeded = "succeeded"
	CommandFailed    = "failed"
	CommandExpired   = "expired"
)

// CrawlJob is one BrandBrain crawl job (fleetCrawlJobDTO). ResultSummary is the counts-only
// outcome, kept raw so the caller reads only what it needs. error_message and result_summary.detail
// are redacted by BrandBrain and capped at about 512 bytes.
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

// CrawlJobQuery filters the crawl-jobs list. Kind, when set, must be CrawlKind; the list is always
// restricted to it. Source may be rea, domain or both.
type CrawlJobQuery struct {
	ID            string
	Status        string
	Source        string
	Kind          string
	AssignedAgent string
	UpdatedSince  string // RFC 3339
	Limit         int    // 0 sends no limit
}

// crawlJobSources are the source values the ops token may filter on.
var crawlJobSources = map[string]bool{"": true, "rea": true, "domain": true, "both": true}

// ListRigs returns every rig and the server's clock, from one request. The per-rig read carries
// the same clock, so the tools never need one call per rig.
func (f *FleetClient) ListRigs(ctx context.Context) (*RigList, error) {
	var out struct {
		Rigs       []Rig      `json:"rigs"`
		ServerTime *time.Time `json:"server_time"`
	}
	if err := f.call(ctx, http.MethodGet, "/api/v1/fleet/rigs", nil, nil, "", &out); err != nil {
		return nil, err
	}
	return &RigList{Rigs: out.Rigs, ServerTime: out.ServerTime}, nil
}

// CommandByRequestKey reads one command by the key it was created under. It is ErrCommandNotFound
// when no command has that key. It is how a POST whose outcome was lost is settled, and how a log
// request is polled without listing the rig's other commands.
func (f *FleetClient) CommandByRequestKey(ctx context.Context, rigID, requestKey string) (*Command, error) {
	path, err := rigPath(rigID)
	if err != nil {
		return nil, err
	}
	if !requestKeyPattern.MatchString(requestKey) {
		return nil, ErrInvalidRequest
	}
	q := url.Values{}
	q.Set("request_key", requestKey)
	var out struct {
		Command Command `json:"command"`
	}
	if err := f.call(ctx, http.MethodGet, path+"/commands", q, nil, "", &out); err != nil {
		return nil, err
	}
	if out.Command.ID == "" {
		return nil, ErrUnavailable
	}
	return &out.Command, nil
}

// ListCrawlJobs reads one page of housing crawl jobs and the queue summary.
func (f *FleetClient) ListCrawlJobs(ctx context.Context, q CrawlJobQuery) (*CrawlJobsPage, error) {
	if q.Kind != "" && q.Kind != CrawlKind {
		return nil, ErrInvalidRequest
	}
	if !crawlJobSources[q.Source] {
		return nil, ErrInvalidRequest
	}
	v := url.Values{}
	set := func(k, s string) {
		if s != "" {
			v.Set(k, s)
		}
	}
	set("id", q.ID)
	set("status", q.Status)
	set("source", q.Source)
	set("kind", CrawlKind)
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

// RequestRuntimeLogs asks a rig for its logs. source is housing or runtime. The answer is the
// command, created under idemKey; its result arrives later, read with CommandByRequestKey.
func (f *FleetClient) RequestRuntimeLogs(ctx context.Context, rigID, source, idemKey string) (*Command, error) {
	if source != LogSourceHousing && source != LogSourceRuntime {
		return nil, ErrCommandRefused
	}
	return f.command(ctx, rigID, CommandCollectRuntimeLogs, map[string]any{"source": source}, idemKey)
}

// RunDrain asks a rig to run its housing drain now. This is a LIVE crawl: drain-until-empty over
// the whole backlog, using one of the rig's live runs (a limited number per window). The ops token
// refuses dry runs (403 fleet_ops_forbidden), so dry_run is always false and never configurable.
// A 429 is ErrRateLimited; a refused request is a *ConflictError.
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
	if !requestKeyPattern.MatchString(idemKey) {
		return nil, ErrInvalidRequest
	}
	body, err := json.Marshal(struct {
		Kind    string `json:"kind"`
		Payload any    `json:"payload"`
	}{Kind: kind, Payload: payload})
	if err != nil {
		return nil, ErrInvalidRequest
	}
	// BrandBrain answers 201 with {"command": ...} on create, and the same on an idempotent replay.
	var out struct {
		Command Command `json:"command"`
	}
	if err := f.call(ctx, http.MethodPost, path+"/commands", nil, body, idemKey, &out); err != nil {
		return nil, err
	}
	if out.Command.ID == "" {
		// A 2xx with no command cannot be followed up. The outcome is not known.
		return nil, ErrUnavailable
	}
	return &out.Command, nil
}

// rigIDPattern is BrandBrain's rig id shape. Anything else is refused before a request is built.
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
		switch bodyCode(raw) {
		case "rig_not_found":
			return ErrRigNotFound
		case "command_not_found":
			return ErrCommandNotFound
		default:
			// A plain 404 (a route that is not deployed, a proxy page) says nothing about the rig.
			return ErrUnavailable
		}
	case http.StatusBadRequest:
		return ErrInvalidRequest
	case http.StatusUnauthorized, http.StatusForbidden:
		// 403 fleet_ops_forbidden: the ops token refusing a request it may not make.
		return ErrRejected
	case http.StatusConflict:
		// Nothing was created. The code is BrandBrain's closed refusal, or unknown.
		code := bodyCode(raw)
		if code == "" {
			code = "unknown"
		}
		return &ConflictError{Code: code}
	case http.StatusTooManyRequests:
		return ErrRateLimited
	default:
		return ErrUnavailable
	}
}

// bodyCode returns BrandBrain's closed code from an error body ({"code": ...} or {"error": ...}).
// Free text is never returned.
func bodyCode(raw []byte) string {
	var body struct {
		Code  string `json:"code"`
		Error string `json:"error"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return ""
	}
	for _, c := range []string{body.Code, body.Error} {
		if closedCode.MatchString(c) {
			return c
		}
	}
	return ""
}
