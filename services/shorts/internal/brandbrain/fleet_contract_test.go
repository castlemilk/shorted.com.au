package brandbrain

// fleet_contract_test.go pins the decoders to BrandBrain's real response shapes. Each body below is
// transcribed from the handler that writes it, at BrandBrain origin/main 780a11b5, and the handler
// is named beside it. If BrandBrain changes a field or a wrapper, the matching test fails here
// first. Keep the bodies in step with the source, not with this client.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// rigsListBody is GET /api/v1/fleet/rigs: handleListRigs writes {rigs, summary, server_time, ...}.
// Each rig is rigCredentialDTO, which embeds rigDTO, so its fields sit flat in the item.
const rigsListBody = `{
  "rigs": [{
    "id": "rig-1", "display_name": "Studio Mac", "rig_type": "mac", "version": "1.21.0",
    "admin_state": "active", "liveness": "online", "accepts_work": true,
    "last_heartbeat_at": "2026-10-31T08:59:30Z",
    "resources": {"housing_crawl": {
      "schema": 1, "state": "running",
      "env": {"driver": "1.4.2", "chrome": "128.0.6613.120"},
      "lock": "held",
      "in_flight": {"job": "drain", "phase": "sweeping", "round": 3,
        "last_progress_at": "2026-10-31T08:58:00Z",
        "counts": {"claimed": 40, "succeeded": 31, "failed": 2, "deferred": 1, "blocked": 0, "listings": 512}},
      "circuit": [],
      "portals": [
        {"source": "rea", "state": "open", "consecutive_blocked": 3, "backoff_s": 900,
         "open_until": "2026-10-31T09:30:00Z", "updated_at": "2026-10-31T08:45:00Z"},
        {"source": "domain", "state": "closed", "consecutive_blocked": 0, "backoff_s": 0,
         "updated_at": "2026-10-31T08:50:00Z"}
      ],
      "ingest": {"probe": "ok", "last_ok_at": "2026-10-31T08:57:00Z"},
      "jobs": {
        "drain": {"enabled": true, "next_run_at": "2026-10-31T10:00:00Z",
          "last": {"outcome": "blocked", "exit_code": 3, "finished_at": "2026-10-31T06:00:00Z",
            "counts": {"claimed": 12, "succeeded": 9, "blocked": 3},
            "alarm": "stale_suburbs"}}
      }
    }}
  }],
  "summary": {"by_liveness": {"online": 1}},
  "server_time": "2026-10-31T09:00:00Z",
  "token_expiry_available": true
}`

// rigsListNoBlockBody is the same route for a rig with no housing block (version skew, or a rig
// that has never reported one). Its portals must read as unknown, never as clear.
const rigsListNoBlockBody = `{
  "rigs": [{"id": "rig-2", "version": "1.0.3", "liveness": "online", "resources": {}}],
  "server_time": "2026-10-31T09:00:00Z"
}`

// commandCreatedBody is POST /api/v1/fleet/rigs/{id}/commands: handleCreateCommand writes
// {"command": rigCommandDTO} with 201, on create and on an idempotent replay alike.
const commandCreatedBody = `{"command": {
  "id": "cmd-1", "rig_id": "rig-1", "request_key": "smoke-20261031T093000Z-0a1b2c3d:drain",
  "kind": "housing_crawl_run", "payload": {"job": "drain", "dry_run": false},
  "status": "pending", "result": "", "delivery_attempts": 0, "events": [],
  "created_via": "api", "created_by": "fleet-ops:shorted-admin",
  "created_at": "2026-10-31T09:00:01Z", "expires_at": "2026-10-31T09:10:01Z"
}}`

// commandRequestKeyBody is GET /commands?request_key=<key>: handleListRigCommands writes the
// single command as {"command": rigCommandDTO}. A succeeded log request carries its text in
// result_data.runtime_logs (domain.RigManagementResult.RuntimeLogs).
const commandRequestKeyBody = `{"command": {
  "id": "cmd-2", "rig_id": "rig-1", "request_key": "logs-7f2e9a10",
  "kind": "collect_runtime_logs", "payload": {"source": "housing"},
  "status": "succeeded", "result": "ok",
  "result_data": {"schema_version": 1, "phase": "completed", "observed_at": "2026-10-31T09:00:20Z",
    "runtime_logs": {"source": "housing", "captured_at": "2026-10-31T09:00:19Z",
      "requested_bytes": 65536, "bytes": 412, "truncated": false, "redacted": true,
      "redaction_policy": "runtime-log-v1", "redaction_count": 2,
      "text": "2026-10-31T09:00:01 drain start job=abc\n2026-10-31T09:00:02 suburb bondi rea ok"}},
  "delivery_attempts": 1, "events": [], "created_by": "fleet-ops:shorted-admin",
  "created_at": "2026-10-31T09:00:00Z", "completed_at": "2026-10-31T09:00:20Z",
  "expires_at": "2026-10-31T09:10:00Z"
}}`

// commandNotFoundBody is GET /commands?request_key=<unknown>: writeManagementError, 404.
const commandNotFoundBody = `{"error":"command_not_found","code":"command_not_found"}`

// conflictBody is a 409 from the housing command path: writeManagementError(w, code, 409).
const conflictBody = `{"error":"rig_not_active","code":"rig_not_active"}`

// crawlJobsBody is GET /api/v1/fleet/crawl-jobs: handleListFleetCrawlJobs writes {jobs, summary}.
// error_message and result_summary.detail are redacted and capped by BrandBrain.
const crawlJobsBody = `{
  "jobs": [{
    "id": "2d1f6c0e-6b1a-4d2e-9a77-0f3c1b2a9e10", "kind": "housing", "suburb": "Bondi",
    "state": "NSW", "postcode": "2026", "source": "domain", "tier": "listings", "priority": 100,
    "status": "failed", "assigned_agent": "rig-1", "attempts": 2, "max_attempts": 3,
    "error_message": "blocked at [url] after 2 sweeps",
    "result_summary": {"suburbs": 1, "listings": 0, "events": 0, "blocked_sweeps": 2,
      "needs_rewarm": true, "detail": "portal [url] refused the session; [email] on record"},
    "created_at": "2026-10-31T08:00:00Z", "updated_at": "2026-10-31T08:30:00Z",
    "started_at": "2026-10-31T08:10:00Z", "completed_at": "2026-10-31T08:30:00Z", "not_before": null
  }, {
    "id": "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d", "kind": "housing", "suburb": "Manly",
    "state": "NSW", "postcode": "2095", "source": "rea", "tier": "listings", "priority": 5,
    "status": "pending", "assigned_agent": "", "attempts": 0, "max_attempts": 3,
    "error_message": "", "result_summary": null,
    "created_at": "2026-10-31T08:40:00Z", "updated_at": "2026-10-31T08:40:00Z",
    "started_at": null, "completed_at": null, "not_before": "2026-10-31T11:00:00Z"
  }],
  "summary": {"by_status_source": [
    {"status": "pending", "source": "rea", "count": 1},
    {"status": "failed", "source": "domain", "count": 1}
  ]}
}`

func serveBody(t *testing.T, status int, body string) *FleetClient {
	t.Helper()
	srv, _ := newFleetStandIn(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	})
	return fleetClient(t, srv.URL, 0)
}

func TestContractRigsListDecodesTheRealShape(t *testing.T) {
	list, err := serveBody(t, http.StatusOK, rigsListBody).ListRigs(context.Background())
	require.NoError(t, err)
	require.NotNil(t, list.ServerTime, "server_time sits on the list response and must decode")
	assert.Equal(t, time.Date(2026, 10, 31, 9, 0, 0, 0, time.UTC), *list.ServerTime)

	require.Len(t, list.Rigs, 1)
	rig := list.Rigs[0]
	assert.Equal(t, "1.21.0", rig.Version, "a semver version must decode")
	assert.Equal(t, "online", rig.Liveness)
	hc := rig.Resources.HousingCrawl
	require.NotNil(t, hc)
	assert.Equal(t, "running", hc.State)
	require.NotNil(t, hc.Env)
	assert.Equal(t, "128.0.6613.120", hc.Env.Chrome)
	require.Len(t, hc.Portals, 2)
	assert.Equal(t, "open", hc.Portals[0].State)
	require.NotNil(t, hc.Portals[0].OpenUntil)
	require.NotNil(t, hc.InFlight)
	assert.Equal(t, "drain", hc.InFlight.Job)
	require.NotNil(t, hc.InFlight.Counts)
	assert.Equal(t, 512, hc.InFlight.Counts.Listings)

	drain, ok := hc.Jobs["drain"]
	require.True(t, ok, "jobs is a map keyed by job name")
	assert.True(t, drain.Enabled)
	require.NotNil(t, drain.Last)
	assert.Equal(t, "stale_suburbs", drain.Last.Alarm, "the alarm is on jobs.<job>.last, as a string")
	assert.Equal(t, 9, drain.Last.Counts.Succeeded)
}

func TestContractRigWithNoHousingBlockReadsAsNil(t *testing.T) {
	list, err := serveBody(t, http.StatusOK, rigsListNoBlockBody).ListRigs(context.Background())
	require.NoError(t, err)
	require.Len(t, list.Rigs, 1)
	assert.Nil(t, list.Rigs[0].Resources.HousingCrawl, "no housing block must stay nil, so the tools read unknown")
}

func TestContractCommandCreateDecodesTheWrapper(t *testing.T) {
	cmd, err := serveBody(t, http.StatusCreated, commandCreatedBody).RunDrain(context.Background(), "rig-1", "smoke-20261031T093000Z-0a1b2c3d:drain")
	require.NoError(t, err)
	assert.Equal(t, "cmd-1", cmd.ID)
	assert.Equal(t, "housing_crawl_run", cmd.Kind)
	assert.Equal(t, "pending", cmd.Status)
	assert.Equal(t, "smoke-20261031T093000Z-0a1b2c3d:drain", cmd.RequestKey)
}

// An idempotent replay is the same wrapper, so a retry is read the same way.
func TestContractCommandReplayDecodesTheSameWrapper(t *testing.T) {
	cmd, err := serveBody(t, http.StatusCreated, commandCreatedBody).RunDrain(context.Background(), "rig-1", "smoke-20261031T093000Z-0a1b2c3d:drain")
	require.NoError(t, err)
	assert.Equal(t, "cmd-1", cmd.ID, "a replay answers the stored command under the same wrapper")
}

func TestContractCommandByRequestKeyDecodesTheResult(t *testing.T) {
	cmd, err := serveBody(t, http.StatusOK, commandRequestKeyBody).CommandByRequestKey(context.Background(), "rig-1", "logs-7f2e9a10")
	require.NoError(t, err)
	assert.Equal(t, "succeeded", cmd.Status)
	require.NotNil(t, cmd.ResultData)
	require.NotNil(t, cmd.ResultData.RuntimeLogs)
	assert.Contains(t, cmd.ResultData.RuntimeLogs.Text, "suburb bondi rea ok")
	assert.True(t, cmd.ResultData.RuntimeLogs.Redacted)
}

func TestContractCommandByRequestKeyNotFoundIsDefinite(t *testing.T) {
	_, err := serveBody(t, http.StatusNotFound, commandNotFoundBody).CommandByRequestKey(context.Background(), "rig-1", "logs-7f2e9a10")
	assert.ErrorIs(t, err, ErrCommandNotFound, "no command under the key is a definite answer, not an unknown outcome")
}

func TestContractConflictDecodesTheCode(t *testing.T) {
	_, err := serveBody(t, http.StatusConflict, conflictBody).RunDrain(context.Background(), "rig-1", "smoke-20261031T093000Z-0a1b2c3d:drain")
	assert.ErrorIs(t, err, ErrConflict)
	var ce *ConflictError
	require.ErrorAs(t, err, &ce)
	assert.Equal(t, "rig_not_active", ce.Code)
}

func TestContractCrawlJobsDecodesTheRealShape(t *testing.T) {
	page, err := serveBody(t, http.StatusOK, crawlJobsBody).ListCrawlJobs(context.Background(), CrawlJobQuery{Kind: CrawlKind, Source: "both"})
	require.NoError(t, err)
	require.Len(t, page.Jobs, 2)
	failed := page.Jobs[0]
	assert.Equal(t, "failed", failed.Status)
	assert.Equal(t, 100, failed.Priority)
	assert.Equal(t, "blocked at [url] after 2 sweeps", failed.ErrorMessage)
	var summary struct {
		BlockedSweeps int  `json:"blocked_sweeps"`
		NeedsRewarm   bool `json:"needs_rewarm"`
	}
	require.NoError(t, json.Unmarshal(failed.ResultSummary, &summary))
	assert.Equal(t, 2, summary.BlockedSweeps)
	assert.True(t, summary.NeedsRewarm)
	require.NotNil(t, failed.CreatedAt, "created_at is an RFC 3339 string on the wire")

	pending := page.Jobs[1]
	assert.Equal(t, "pending", pending.Status)
	assert.Equal(t, "null", string(pending.ResultSummary), "a job with no summary carries null")
	require.NotNil(t, pending.NotBefore)
	assert.Equal(t, 1, page.Summary.ByStatusSource[0].Count)
}
