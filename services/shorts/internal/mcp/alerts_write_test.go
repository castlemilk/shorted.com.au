package mcp

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/pkg/ratelimit"
)

// recordingAlerts is an AlertsWriteOperator that records every call, so a test can
// say which owner the tools acted for and whether anything was written at all.
type recordingAlerts struct {
	calls []string
	uids  []string
	// addressNote is what AddressNote returns: the unverified sentence, or "" when verified.
	addressNote string
}

// AddressNote implements AddressNoter for the fake.
func (r *recordingAlerts) AddressNote(context.Context, string) string { return r.addressNote }

func (r *recordingAlerts) note(name, uid string) {
	r.calls = append(r.calls, name)
	r.uids = append(r.uids, uid)
}

func (r *recordingAlerts) ListMyAlerts(_ context.Context, uid string, _, _ int) (*ListMyAlertsOutput, error) {
	r.note("list", uid)
	return &ListMyAlertsOutput{Monitors: []AlertsOwnMonitor{}}, nil
}
func (r *recordingAlerts) CreateAlert(_ context.Context, uid string, in CreateAlertInput) (*AlertsOwnMonitor, error) {
	r.note("create", uid)
	return &AlertsOwnMonitor{ID: "7d2c4f1e-0a9b-4c3d-8e2f-1a2b3c4d5e6f", Target: in.Target, Cadence: in.Cadence, Condition: in.Condition}, nil
}
func (r *recordingAlerts) SetAlertPaused(_ context.Context, uid, id string, paused bool) (*AlertsOwnMonitor, error) {
	if paused {
		r.note("pause", uid)
	} else {
		r.note("resume", uid)
	}
	return &AlertsOwnMonitor{ID: id, Status: "active"}, nil
}
func (r *recordingAlerts) DeleteAlert(_ context.Context, uid, id string) error {
	r.note("delete", uid)
	return nil
}
func (r *recordingAlerts) AlertHistory(_ context.Context, uid, _ string, _, _ int) (*AlertHistoryOutput, error) {
	r.note("history", uid)
	return &AlertHistoryOutput{Events: []AlertHistoryEvent{}}, nil
}

// publicStack composes the public /mcp handler the way serve.go does: the bearer
// middleware (optional, as on /mcp) around HandlerWithAlerts.
func publicStack(t *testing.T, validator ClaimsValidator, op AlertsWriteOperator, alerts bool) *httptest.Server {
	t.Helper()
	var h http.Handler
	if alerts {
		h = HandlerWithAlerts(&fakeDataSource{}, op, ProtectedResourceMetadataURL(conformanceOrigin))
	} else {
		h = Handler(&fakeDataSource{})
	}
	// The same composition serve.go mounts: the challenge scope wrapper, the optional bearer
	// middleware, BatchGuard, then the rate limiter (cost and identity as in production), then
	// the handler. The
	// allowance is generous, so these tests exercise the path, not the limit.
	cfg := ratelimit.DefaultConfig()
	cfg.Enabled = true
	limiter := ratelimit.NewAppLimiter(cfg, memUsageStore{})
	t.Cleanup(func() { _ = limiter.Close() })
	limited := ratelimit.NewHTTPMiddleware(limiter, cfg,
		RateLimitIdentity(nil),
		ratelimit.WithCost(RateLimitCost),
		ratelimit.WithRejection(RateLimitRejection(ProtectedResourceMetadataURL(conformanceOrigin))),
	)(h)
	mounted := WithChallengeScope(OptionalBearerToken(NewTokenVerifier(validator, ResourceURI(conformanceOrigin)), BearerTokenOptions(conformanceOrigin))(BatchGuard(limited)))
	srv := httptest.NewServer(mounted)
	t.Cleanup(srv.Close)
	return srv
}

// publicClaims is a verified token for the public resource carrying these scopes.
func publicClaims(uid string, scopes ...string) stubClaims {
	return stubClaims{claims: &VerifiedClaims{
		UserID: uid, Scopes: scopes, Audience: []string{ResourceURI(conformanceOrigin)}, ExpiresAt: time.Now().Add(time.Hour),
	}}
}

// rpcCall posts one JSON-RPC body to /mcp and returns the status, the headers and the body.
func rpcCall(t *testing.T, srv *httptest.Server, token, body string) (*http.Response, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/mcp", strings.NewReader(body))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	raw, _ := io.ReadAll(resp.Body)
	return resp, string(raw)
}

const listToolsBody = `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`

func toolCallBody(id int, name, args string) string {
	return `{"jsonrpc":"2.0","id":` + strconv.Itoa(id) + `,"method":"tools/call","params":{"name":"` + name + `","arguments":` + args + `}}`
}

// listedTools decodes a tools/list response into name -> annotations.
func listedTools(t *testing.T, body string) map[string]map[string]any {
	t.Helper()
	// The streamable transport answers in SSE framing: the JSON-RPC message is on a data line.
	for _, line := range strings.Split(body, "\n") {
		if data, ok := strings.CutPrefix(line, "data: "); ok {
			body = data
		}
	}
	var env struct {
		Result struct {
			Tools []struct {
				Name        string         `json:"name"`
				Annotations map[string]any `json:"annotations"`
			} `json:"tools"`
		} `json:"result"`
	}
	require.NoError(t, json.Unmarshal([]byte(body), &env), body)
	out := map[string]map[string]any{}
	for _, tool := range env.Result.Tools {
		out[tool.Name] = tool.Annotations
	}
	return out
}

var alertToolNames = []string{"list_my_alerts", "create_alert", "pause_alert", "resume_alert", "delete_alert", "list_my_alert_history"}

// toolJSONByName decodes a tools/list response into name -> the tool's exact JSON, so a
// test can compare one tool's bytes without caring what else the list holds.
func toolJSONByName(t *testing.T, body string) map[string]json.RawMessage {
	t.Helper()
	for _, line := range strings.Split(body, "\n") {
		if data, ok := strings.CutPrefix(line, "data: "); ok {
			body = data
		}
	}
	var env struct {
		Result struct {
			Tools []json.RawMessage `json:"tools"`
		} `json:"result"`
	}
	require.NoError(t, json.Unmarshal([]byte(body), &env), body)
	out := map[string]json.RawMessage{}
	for _, raw := range env.Result.Tools {
		var named struct {
			Name string `json:"name"`
		}
		require.NoError(t, json.Unmarshal(raw, &named))
		out[named.Name] = raw
	}
	return out
}

// Constraint 1, as amended: an anonymous or unscoped caller's tools/list equals the old list
// PLUS exactly one tool, manage_my_alerts. Every old tool's JSON is byte-identical, and no
// other tool appears. A scoped caller's list does not carry the discovery tool.
func TestAnonymousAndUnscopedToolsListIsOldPlusOneTool(t *testing.T) {
	op := &recordingAlerts{}
	before := publicStack(t, publicClaims("uid-a", "shorts:read"), nil, false)
	after := publicStack(t, publicClaims("uid-a", "shorts:read"), op, true)

	oldResp, oldBody := rpcCall(t, before, "", listToolsBody)
	_, anonBody := rpcCall(t, after, "", listToolsBody)
	t.Logf("anonymous tools/list wire body: %d bytes before, %d after (HTTP %d)", len(oldBody), len(anonBody), oldResp.StatusCode)
	_, unscopedBody := rpcCall(t, after, "t", listToolsBody)
	oldTools := toolJSONByName(t, oldBody)

	for name, body := range map[string]string{"anonymous": anonBody, "unscoped": unscopedBody} {
		got := toolJSONByName(t, body)
		require.Contains(t, got, ManageMyAlertsTool, "%s must see the discovery tool", name)
		assert.Len(t, got, len(oldTools)+1, "%s: exactly one tool more than the old list", name)
		for n, raw := range oldTools {
			assert.JSONEq(t, string(raw), string(got[n]), "%s: %s changed", name, n)
		}
	}

	scoped := publicStack(t, publicClaims("uid-a", ScopeAlertsWrite), op, true)
	_, scopedList := rpcCall(t, scoped, "t", listToolsBody)
	assert.NotContains(t, toolJSONByName(t, scopedList), ManageMyAlertsTool, "a scoped caller must not see the discovery tool")
}

// Constraint 1: a verified token carrying alerts:write sees the alert tools, and only
// it does. Read-only scopes alone do not.
func TestAlertToolsAppearOnlyForTheWriteScope(t *testing.T) {
	op := &recordingAlerts{}
	srvWrite := publicStack(t, publicClaims("uid-a", "shorts:read", ScopeAlertsWrite), op, true)
	_, body := rpcCall(t, srvWrite, "t", listToolsBody)
	tools := listedTools(t, body)
	for _, name := range alertToolNames {
		assert.Contains(t, tools, name, "%s must be listed for alerts:write", name)
	}
	// The base tools are still there.
	assert.Contains(t, tools, "list_top_shorts")
}

// Constraint 1: the scoped tools/list is budgeted on its own. It is paid by a signed-in
// client that asked for alerts:write, so it must stay in the same range as the base list.
func TestScopedToolsListStaysWithinItsBudget(t *testing.T) {
	const budget = 112 * 1024
	op := &recordingAlerts{}
	srv := publicStack(t, publicClaims("uid-a", ScopeAlertsWrite), op, true)
	_, body := rpcCall(t, srv, "t", listToolsBody)
	t.Logf("scoped tools/list: %d bytes", len(body))
	assert.LessOrEqual(t, len(body), budget, "scoped tools/list is %d bytes, over the %d budget", len(body), budget)
}

// Constraint 1: an alert tool called by name without the scope fails, and nothing reaches
// the operator. Anonymous, read-only, and a token with no scope at all are all refused.
func TestAlertToolsCannotBeCalledWithoutTheScope(t *testing.T) {
	call := toolCallBody(2, "create_alert", `{"scope":"stock","target":"BHP","condition":"short_interest_above","cadence":"daily","threshold":5}`)
	for name, claims := range map[string]ClaimsValidator{
		"anonymous": stubClaims{},
		"read-only": publicClaims("uid-a", "shorts:read"),
		"no scopes": publicClaims("uid-a"),
	} {
		op := &recordingAlerts{}
		srv := publicStack(t, claims, op, true)
		token := ""
		if name != "anonymous" {
			token = "t"
		}
		_, body := rpcCall(t, srv, token, call)
		assert.True(t, strings.Contains(body, `"error"`) || strings.Contains(body, `"isError":true`), "%s: create_alert must fail: %s", name, body)
		assert.NotContains(t, body, `"isError":false`, name)
		assert.Empty(t, op.calls, "%s: the operator must not be reached", name)
	}
}

// Constraint 2: the owner is the verified token's uid. An owner field in the input is
// refused by the schema, so the operator never sees one.
func TestAlertToolsActForTheVerifiedOwnerOnly(t *testing.T) {
	op := &recordingAlerts{}
	srv := publicStack(t, publicClaims("uid-owner", ScopeAlertsWrite), op, true)
	rpcCall(t, srv, "t", toolCallBody(3, "list_my_alerts", `{}`))
	rpcCall(t, srv, "t", toolCallBody(4, "pause_alert", `{"monitor_id":"7d2c4f1e-0a9b-4c3d-8e2f-1a2b3c4d5e6f"}`))
	require.NotEmpty(t, op.uids)
	for _, uid := range op.uids {
		assert.Equal(t, "uid-owner", uid)
	}

	op = &recordingAlerts{}
	srv = publicStack(t, publicClaims("uid-owner", ScopeAlertsWrite), op, true)
	for _, args := range []string{
		`{"scope":"stock","target":"BHP","condition":"short_interest_above","cadence":"daily","threshold":5,"user_id":"uid-victim"}`,
		`{"scope":"stock","target":"BHP","condition":"short_interest_above","cadence":"daily","threshold":5,"uid":"uid-victim"}`,
	} {
		_, body := rpcCall(t, srv, "t", toolCallBody(5, "create_alert", args))
		assert.Contains(t, body, `"isError":true`, "an owner field must be refused: %s", body)
	}
	assert.Empty(t, op.calls, "a refused owner field must not reach the operator")
}

// Constraint 1: the scoped server is stateless. Two calls with no session id both work,
// and the response issues none.
func TestAlertToolsRunStatelesslyAcrossRequests(t *testing.T) {
	op := &recordingAlerts{}
	srv := publicStack(t, publicClaims("uid-a", ScopeAlertsWrite), op, true)
	for i := 0; i < 2; i++ {
		resp, body := rpcCall(t, srv, "t", toolCallBody(6+i, "list_my_alerts", `{}`))
		require.Equal(t, http.StatusOK, resp.StatusCode)
		assert.NotContains(t, body, `"isError":true`, body)
		assert.Empty(t, resp.Header.Get("Mcp-Session-Id"), "a stateless server issues no session id")
	}
	assert.Equal(t, []string{"list", "list"}, op.calls)
}

// Constraint 6: read tools are read-only, delete is destructive, pause and resume are
// idempotent, and create is neither read-only nor destructive.
func TestAlertToolAnnotationsAreHonest(t *testing.T) {
	op := &recordingAlerts{}
	srv := publicStack(t, publicClaims("uid-a", ScopeAlertsWrite), op, true)
	_, body := rpcCall(t, srv, "t", listToolsBody)
	tools := listedTools(t, body)

	for _, name := range []string{"list_my_alerts", "list_my_alert_history"} {
		assert.Equal(t, true, tools[name]["readOnlyHint"], "%s must be read-only", name)
	}
	assert.Equal(t, true, tools["delete_alert"]["destructiveHint"], "delete_alert must be destructive")
	for _, name := range []string{"pause_alert", "resume_alert"} {
		assert.Equal(t, true, tools[name]["idempotentHint"], "%s must be idempotent", name)
	}
	assert.NotEqual(t, true, tools["create_alert"]["readOnlyHint"], "create_alert writes")
	assert.NotEqual(t, true, tools["create_alert"]["destructiveHint"], "create_alert is not destructive")
}

// Constraint 3: the alert tools are NOT in the public registry. The read-only guards
// (TestToolsOnlyCallPublicMethods, the read-only annotation tests) therefore keep their
// meaning, and the write tools are reachable only through the scoped server.
func TestAlertWriteToolsAreOutsideTheReadOnlyRegistry(t *testing.T) {
	registered := map[string]bool{}
	for _, tool := range Registry() {
		registered[tool.Name] = true
	}
	for _, at := range AlertsWriteRegistry() {
		assert.False(t, registered[at.Name], "%s must not be in Registry()", at.Name)
		assert.Equal(t, ScopeAlertsWrite, at.Scope)
	}
	assert.Equal(t, len(alertToolNames), len(AlertsWriteRegistry()))
}

// Constraint 7: each alerts tool call is one rate-limit unit, like every other tools/call.
func TestAlertToolCallsAreMeteredLikeOtherCalls(t *testing.T) {
	for _, name := range alertToolNames {
		body := toolCallBody(1, name, `{}`)
		req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
		assert.Equal(t, 1, RateLimitCost(req), "%s", name)
	}
}

// Constraint 5 (scope list): the write scope is published with the read scopes, and the
// default grant set excludes it.
func TestAlertsWriteIsPublishedButNotDefault(t *testing.T) {
	assert.True(t, slices.Contains(Scopes, ScopeAlertsWrite))
	assert.False(t, slices.Contains(DefaultScopes, ScopeAlertsWrite))
	for _, s := range DefaultScopes {
		assert.True(t, slices.Contains(Scopes, s), "default scope %s must be published", s)
	}
}

// The alert tools call the operator, never a Connect RPC or the store. This reads the tools'
// source and checks it names no RPC client and no store, so the public visibility guard's
// blind spot (the interceptor chain does not run for these calls) stays a known, bounded one.
func TestAlertsWriteToolsReachOnlyTheirOperator(t *testing.T) {
	src, err := os.ReadFile("alerts_write.go")
	require.NoError(t, err)
	for _, forbidden := range []string{"connect.NewRequest", "shortsv1alpha1connect", "ShortsServer", "store.", "ratelimit."} {
		assert.NotContains(t, string(src), forbidden, "the alert tools must not reach %s", forbidden)
	}
}

// The list text names the verification step only when the caller's address is not verified,
// and the tool result carries no field for it, so the tools/list schema is unchanged.
func TestListMyAlertsNotesUnverifiedAddressOnlyWhenUnverified(t *testing.T) {
	const note = "not emailed until your email address is verified"
	cases := []struct {
		name     string
		note     string
		wantNote bool
	}{
		{"unverified address gets the note", "Alerts are recorded but not emailed until your email address is verified in your Shorted account at https://shorted.com.au/alerts.", true},
		{"verified address gets no note", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			op := &recordingAlerts{addressNote: tc.note}
			srv := publicStack(t, publicClaims("uid-owner", ScopeAlertsWrite), op, true)
			_, body := rpcCall(t, srv, "t", toolCallBody(3, "list_my_alerts", `{}`))
			if tc.wantNote {
				assert.Contains(t, body, note)
				assert.Contains(t, body, "https://shorted.com.au/alerts")
			} else {
				assert.NotContains(t, body, note)
			}
			assert.Contains(t, body, "of your alerts", "the list text itself is still returned")
		})
	}
}
