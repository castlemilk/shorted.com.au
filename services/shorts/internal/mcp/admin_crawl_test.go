package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/brandbrain"
)

const crawlToken = "bb-grant-token-SECRET-zq91"

// crawlTrace is the ordered record of every side effect: the shorted store and each
// request that reached the BrandBrain stand-in. Ordering is what several tests pin.
type crawlTrace struct {
	mu     sync.Mutex
	events []string
}

func (c *crawlTrace) add(e string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = append(c.events, e)
}

func (c *crawlTrace) snapshot() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.events...)
}

// fakeCrawlStore is the allowlist. It keeps rows and records each call.
type fakeCrawlStore struct {
	trace        *crawlTrace
	rows         map[string]CrawlRigRow
	listErr      error
	enableErr    error
	disableErr   error
	enabledNote  *string
	disableCalls int
}

func (f *fakeCrawlStore) ListCrawlRigs(context.Context) ([]CrawlRigRow, error) {
	f.trace.add("store.list")
	if f.listErr != nil {
		return nil, f.listErr
	}
	var out []CrawlRigRow
	for _, r := range f.rows {
		out = append(out, r)
	}
	return out, nil
}

func (f *fakeCrawlStore) CrawlRigState(_ context.Context, subject string) (bool, bool, error) {
	r, ok := f.rows[subject]
	return ok, r.Enabled, nil
}

func (f *fakeCrawlStore) EnableCrawlRig(_ context.Context, subject string, note *string) (bool, error) {
	f.trace.add("store.enable " + subject)
	if f.enableErr != nil {
		return false, f.enableErr
	}
	f.enabledNote = note
	prev, ok := f.rows[subject]
	f.rows[subject] = CrawlRigRow{Subject: subject, Enabled: true, CreatedAt: time.Unix(1, 0)}
	return ok && prev.Enabled, nil
}

func (f *fakeCrawlStore) DisableCrawlRig(_ context.Context, subject string) (string, error) {
	f.trace.add("store.disable " + subject)
	f.disableCalls++
	if f.disableErr != nil {
		return "", f.disableErr
	}
	r, ok := f.rows[subject]
	if !ok {
		return shortsNotPresent, nil
	}
	f.rows[subject] = CrawlRigRow{Subject: subject, Enabled: false, CreatedAt: r.CreatedAt}
	if !r.Enabled {
		return ShortedUnchanged, nil
	}
	return ShortedDisabled, nil
}

const shortsNotPresent = "not_present"

// fakeCrawlOp is the crawl half of the admin operator embedded in fakePublisher.
// Its zero value is "not wired", which is what most existing tests need.
type fakeCrawlOp struct {
	store  CrawlRigStore
	grants CrawlGrantClient
	email  string
}

func (f *fakeCrawlOp) CrawlRigStore() CrawlRigStore { return f.store }
func (f *fakeCrawlOp) CrawlGrants() CrawlGrantClient {
	return f.grants
}
func (f *fakeCrawlOp) CrawlOperatorEmail(context.Context, string) string { return f.email }

// bbStandIn is an httptest BrandBrain. It keeps one rig's grant and records every
// request into the trace. Behaviour is switched per test.
type bbStandIn struct {
	granted    bool
	getStatus  int
	putStatus  int
	putDelay   time.Duration
	redirectTo string
	subject    string
	mintReason string
}

func newBBStandIn(t *testing.T, trace *crawlTrace, cfg *bbStandIn) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+crawlToken {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if cfg.redirectTo != "" {
			trace.add("bb.redirect " + r.Method)
			http.Redirect(w, r, cfg.redirectTo, http.StatusTemporaryRedirect)
			return
		}
		if r.Method == http.MethodGet {
			trace.add("bb.GET")
			if cfg.getStatus != 0 && cfg.getStatus != http.StatusOK {
				w.WriteHeader(cfg.getStatus)
				_, _ = fmt.Fprintf(w, `{"detail":"%s"}`, crawlToken)
				return
			}
			writeGrant(w, cfg)
			return
		}
		var body struct {
			Granted bool `json:"granted"`
		}
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		trace.add(fmt.Sprintf("bb.PUT granted=%t operator=%s", body.Granted, r.Header.Get("X-Operator")))
		if cfg.putDelay > 0 {
			time.Sleep(cfg.putDelay)
		}
		if cfg.putStatus != 0 && cfg.putStatus != http.StatusOK {
			w.WriteHeader(cfg.putStatus)
			_, _ = fmt.Fprintf(w, `{"detail":"%s"}`, crawlToken)
			return
		}
		cfg.granted = body.Granted
		writeGrant(w, cfg)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func writeGrant(w http.ResponseWriter, cfg *bbStandIn) {
	reason := cfg.mintReason
	if reason == "" {
		reason = "ok"
	}
	subject := cfg.subject
	if subject == "" {
		subject = "subj-rig-1"
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"rig_id": "rig-1", "granted": cfg.granted, "admin_state": "active", "version": "9",
		"principal_kind": "rig_token", "can_mint": reason == "ok", "can_mint_reason": reason,
		"workload_subject": subject,
	})
}

type crawlFixture struct {
	trace *crawlTrace
	store *fakeCrawlStore
	bb    *bbStandIn
	srv   *httptest.Server
}

// newCrawlFixture wires the real brandbrain client to an httptest stand-in and
// composes the admin stack exactly as serve.go does.
func newCrawlFixture(t *testing.T, bb *bbStandIn, timeout time.Duration) *crawlFixture {
	t.Helper()
	trace := &crawlTrace{}
	if bb == nil {
		bb = &bbStandIn{}
	}
	bbSrv := newBBStandIn(t, trace, bb)
	client, err := brandbrain.NewTestClient(bbSrv.URL, crawlToken, timeout)
	require.NoError(t, err)
	store := &fakeCrawlStore{trace: trace, rows: map[string]CrawlRigRow{}}
	pub := &fakePublisher{fakeCrawlOp: fakeCrawlOp{store: store, grants: client, email: "ops@shorted.com.au"}}
	h := adminStackHandler(t, pub)
	return &crawlFixture{trace: trace, store: store, bb: bb, srv: h}
}

func adminStackHandler(t *testing.T, pub AdminOperator) *httptest.Server {
	t.Helper()
	return adminStack(t, stubClaims{claims: adminClaims()}, onlyAdmin("uid-admin"), pub)
}

// crawlCall posts one tools/call and returns the raw body.
func crawlCall(t *testing.T, srv *httptest.Server, token, name, args string) string {
	t.Helper()
	body := fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":%q,"arguments":%s}}`, name, args)
	_, raw := adminCall(t, srv, token, body)
	return raw
}

// toolResult is the part of a tools/call response a test reads. It accepts the
// plain-JSON and the event-stream framings.
type toolResult struct {
	IsError    bool           `json:"isError"`
	Structured map[string]any `json:"structuredContent"`
	Text       string
	Refused    bool
}

func parseToolResult(t *testing.T, raw string) toolResult {
	t.Helper()
	payload := raw
	if strings.Contains(raw, "data: ") {
		var lines []string
		for _, l := range strings.Split(raw, "\n") {
			if rest, ok := strings.CutPrefix(l, "data: "); ok {
				lines = append(lines, rest)
			}
		}
		payload = strings.Join(lines, "")
	}
	var env struct {
		Result *struct {
			IsError           bool           `json:"isError"`
			StructuredContent map[string]any `json:"structuredContent"`
			Content           []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
		Error json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal([]byte(payload), &env); err != nil {
		t.Fatalf("unparseable response %q: %v", raw, err)
	}
	if env.Result == nil {
		return toolResult{Refused: true}
	}
	out := toolResult{IsError: env.Result.IsError, Structured: env.Result.StructuredContent}
	for _, c := range env.Result.Content {
		out.Text += c.Text
	}
	out.Refused = out.IsError || env.Error != nil
	return out
}

func authorizeArgs(enabled bool, extra string) string {
	return fmt.Sprintf(`{"rig_id":"rig-1","enabled":%t,"confirm":true%s}`, enabled, extra)
}

// --- scope and surface ----------------------------------------------------------

func TestCrawlToolsRefuseATokenWithoutTheCrawlScopeAndNameIt(t *testing.T) {
	fx := newCrawlFixture(t, nil, 0)
	noCrawl := adminClaims()
	noCrawl.Scopes = []string{ScopeNewsPublish}
	srv := adminStack(t, stubClaims{claims: noCrawl}, onlyAdmin("uid-admin"), &fakePublisher{fakeCrawlOp: fakeCrawlOp{store: fx.store, grants: nil}})
	for _, call := range []struct{ name, args string }{
		{CrawlRigsTool, `{}`},
		{CrawlAuthorizeTool, authorizeArgs(true, "")},
	} {
		raw := crawlCall(t, srv, "t", call.name, call.args)
		res := parseToolResult(t, raw)
		assert.True(t, res.IsError, "%s: %s", call.name, raw)
		assert.Contains(t, res.Text, ScopeCrawlAuthorize, "%s must name the scope", call.name)
	}
	assert.Empty(t, fx.trace.snapshot(), "a refused call reached a side effect")
}

func TestCrawlToolsAreAdminOnlyAndWriteToolIsNotReadOnly(t *testing.T) {
	admin := toolNames(t, NewAdminServer(&fakePublisher{}))
	public := toolNames(t, NewServer(&fakeDataSource{}))
	for _, name := range []string{CrawlRigsTool, CrawlAuthorizeTool} {
		assert.True(t, admin[name] != nil, "%s missing from the admin server", name)
		assert.Nil(t, public[name], "%s leaked onto the public server", name)
	}
	assert.False(t, readOnlyHint(t, CrawlAuthorizeTool), "the write tool is annotated read-only")
	assert.True(t, readOnlyHint(t, CrawlRigsTool), "the read tool is not annotated read-only")
}

func toolNames(t *testing.T, server *sdk.Server) map[string]*sdk.Tool {
	t.Helper()
	ctx := context.Background()
	clientT, serverT := sdk.NewInMemoryTransports()
	_, err := server.Connect(ctx, serverT, nil)
	require.NoError(t, err)
	session, err := sdk.NewClient(&sdk.Implementation{Name: "t", Version: "1"}, nil).Connect(ctx, clientT, nil)
	require.NoError(t, err)
	defer func() { _ = session.Close() }()
	res, err := session.ListTools(ctx, nil)
	require.NoError(t, err)
	out := map[string]*sdk.Tool{}
	for _, tool := range res.Tools {
		out[tool.Name] = tool
	}
	return out
}

// --- closed input ----------------------------------------------------------------

func TestCrawlInputsAreClosedAndSendNothing(t *testing.T) {
	cases := map[string]string{
		"unknown field":   `{"rig_id":"rig-1","enabled":true,"confirm":true,"extra":1}`,
		"string bool":     `{"rig_id":"rig-1","enabled":"true","confirm":true}`,
		"integer bool":    `{"rig_id":"rig-1","enabled":1,"confirm":true}`,
		"confirm as text": `{"rig_id":"rig-1","enabled":true,"confirm":"true"}`,
		"missing enabled": `{"rig_id":"rig-1","confirm":true}`,
		"bad rig id":      `{"rig_id":"a b","enabled":true,"confirm":true}`,
		"path rig id":     `{"rig_id":"../x","enabled":false}`,
		"note too long":   fmt.Sprintf(`{"rig_id":"rig-1","enabled":true,"confirm":true,"note":"%s"}`, strings.Repeat("x", 201)),
	}
	for name, args := range cases {
		fx := newCrawlFixture(t, nil, 0)
		raw := crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, args)
		assert.True(t, parseToolResult(t, raw).Refused, "%s was accepted: %s", name, raw)
		assert.Empty(t, fx.trace.snapshot(), "%s reached a side effect", name)
	}
}

func TestEnableWithoutConfirmIsRefusedAndSendsNothing(t *testing.T) {
	fx := newCrawlFixture(t, nil, 0)
	raw := crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, `{"rig_id":"rig-1","enabled":true}`)
	res := parseToolResult(t, raw)
	assert.True(t, res.Refused)
	assert.Contains(t, res.Text, "confirm=true")
	assert.Empty(t, fx.trace.snapshot(), "an enable without confirm reached BrandBrain or shorted")
}

func TestDisableNeedsNoConfirm(t *testing.T) {
	fx := newCrawlFixture(t, &bbStandIn{granted: true}, 0)
	fx.store.rows["subj-rig-1"] = CrawlRigRow{Subject: "subj-rig-1", Enabled: true}
	raw := crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, `{"rig_id":"rig-1","enabled":false}`)
	res := parseToolResult(t, raw)
	require.False(t, res.Refused, raw)
	assert.Equal(t, "disabled", res.Structured["shorted"])
}

// --- sequencing ------------------------------------------------------------------

func TestEnableRunsGetPutThenTheShortedWriteForTheServersSubject(t *testing.T) {
	fx := newCrawlFixture(t, &bbStandIn{subject: "subj-from-brandbrain"}, 0)
	raw := crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, authorizeArgs(true, `,"note":"  the Sydney rig  "`))
	res := parseToolResult(t, raw)
	require.False(t, res.Refused, raw)

	assert.Equal(t, []string{
		"bb.GET",
		"bb.PUT granted=true operator=ops@shorted.com.au",
		"store.enable subj-from-brandbrain",
	}, fx.trace.snapshot())
	require.NotNil(t, fx.store.enabledNote)
	assert.Equal(t, "the Sydney rig", *fx.store.enabledNote, "the note is trimmed")
	assert.Equal(t, "enabled", res.Structured["shorted"])
	assert.Equal(t, "granted", res.Structured["brandbrain"])
	assert.Equal(t, true, res.Structured["can_mint"])
	assert.Equal(t, "subj-from-brandbrain", res.Structured["workload_subject"])
}

func TestRepeatedEnableReportsUnchangedOnBothSides(t *testing.T) {
	fx := newCrawlFixture(t, nil, 0)
	first := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, authorizeArgs(true, "")))
	require.False(t, first.Refused)
	second := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, authorizeArgs(true, "")))
	require.False(t, second.Refused)
	assert.Equal(t, "unchanged", second.Structured["shorted"])
	assert.Equal(t, "unchanged", second.Structured["brandbrain"])
}

func TestDisableWritesShortedBeforeTheRevokingPut(t *testing.T) {
	fx := newCrawlFixture(t, &bbStandIn{granted: true}, 0)
	fx.store.rows["subj-rig-1"] = CrawlRigRow{Subject: "subj-rig-1", Enabled: true}
	res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, `{"rig_id":"rig-1","enabled":false}`))
	require.False(t, res.Refused)
	assert.Equal(t, []string{
		"bb.GET",
		"store.disable subj-rig-1",
		"bb.PUT granted=false operator=ops@shorted.com.au",
	}, fx.trace.snapshot())
	assert.Equal(t, "revoked", res.Structured["brandbrain"])
}

func TestDisableUpdatesShortedBeforeAPutThatFails(t *testing.T) {
	fx := newCrawlFixture(t, &bbStandIn{granted: true, putStatus: http.StatusServiceUnavailable}, 0)
	fx.store.rows["subj-rig-1"] = CrawlRigRow{Subject: "subj-rig-1", Enabled: true}
	res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, `{"rig_id":"rig-1","enabled":false}`))
	require.False(t, res.Refused)
	events := fx.trace.snapshot()
	require.Len(t, events, 3)
	assert.Equal(t, "store.disable subj-rig-1", events[1], "shorted must be written before the revoke is attempted")
	assert.Equal(t, "disabled", res.Structured["shorted"])
	assert.Equal(t, "unknown", res.Structured["brandbrain"], "a 5xx on the PUT is an unknown outcome")
	assert.False(t, fx.store.rows["subj-rig-1"].Enabled)
}

func TestDisableRevokesEvenWhenTheShortedWriteFails(t *testing.T) {
	fx := newCrawlFixture(t, &bbStandIn{granted: true}, 0)
	fx.store.rows["subj-rig-1"] = CrawlRigRow{Subject: "subj-rig-1", Enabled: true}
	fx.store.disableErr = errors.New("connection reset")
	res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, `{"rig_id":"rig-1","enabled":false}`))
	require.False(t, res.Refused)
	assert.Equal(t, "failed", res.Structured["shorted"])
	assert.Equal(t, "revoked", res.Structured["brandbrain"])
	assert.Contains(t, fx.trace.snapshot(), "bb.PUT granted=false operator=ops@shorted.com.au")
}

func TestRepeatedDisableIsUnchanged(t *testing.T) {
	fx := newCrawlFixture(t, &bbStandIn{granted: false}, 0)
	fx.store.rows["subj-rig-1"] = CrawlRigRow{Subject: "subj-rig-1", Enabled: false}
	res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, `{"rig_id":"rig-1","enabled":false}`))
	require.False(t, res.Refused)
	assert.Equal(t, "unchanged", res.Structured["shorted"])
	assert.Equal(t, "unchanged", res.Structured["brandbrain"])
}

func TestDisableWithoutAnAllowlistRowReportsNotPresentAndWritesNoRow(t *testing.T) {
	fx := newCrawlFixture(t, &bbStandIn{granted: true}, 0)
	res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, `{"rig_id":"rig-1","enabled":false}`))
	require.False(t, res.Refused)
	assert.Equal(t, "not_present", res.Structured["shorted"])
	assert.Empty(t, fx.store.rows, "disable created a row")
}

// An unknown PUT outcome on enable stops the run before shorted is touched.
func TestEnableWithAnUnknownPutStopsBeforeShorted(t *testing.T) {
	fx := newCrawlFixture(t, &bbStandIn{putStatus: http.StatusInternalServerError}, 0)
	res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, authorizeArgs(true, "")))
	require.False(t, res.Refused)
	assert.Equal(t, "unknown", res.Structured["brandbrain"])
	assert.Equal(t, "unchanged", res.Structured["shorted"])
	for _, e := range fx.trace.snapshot() {
		assert.NotContains(t, e, "store.enable", "shorted was written after an unknown PUT")
	}
	assert.Empty(t, fx.store.rows)
	assert.Contains(t, strings.Join(stringsOf(res.Structured["next_steps"]), " "), "Nothing was retried automatically")
}

func TestEnableWithATimedOutPutIsUnknown(t *testing.T) {
	fx := newCrawlFixture(t, &bbStandIn{putDelay: 300 * time.Millisecond}, 60*time.Millisecond)
	res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, authorizeArgs(true, "")))
	require.False(t, res.Refused)
	assert.Equal(t, "unknown", res.Structured["brandbrain"])
	assert.Empty(t, fx.store.rows, "shorted was written after a timed-out PUT")
}

func TestA404OnTheGetStopsWithNothingWritten(t *testing.T) {
	fx := newCrawlFixture(t, &bbStandIn{getStatus: http.StatusNotFound}, 0)
	raw := crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, authorizeArgs(true, ""))
	res := parseToolResult(t, raw)
	assert.True(t, res.Refused)
	assert.Contains(t, res.Text, "rig_not_found")
	assert.Equal(t, []string{"bb.GET"}, fx.trace.snapshot(), "a 404 must stop before any PUT or shorted write")
}

func TestADisableWhoseGetFailsStillRevokesAndExplainsTheShortedRow(t *testing.T) {
	fx := newCrawlFixture(t, &bbStandIn{getStatus: http.StatusInternalServerError}, 0)
	res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, `{"rig_id":"rig-1","enabled":false}`))
	require.False(t, res.Refused, res.Text)
	assert.Equal(t, "failed", res.Structured["shorted"], "the subject is unknown, so the row cannot be named")
	assert.Equal(t, "revoked", res.Structured["brandbrain"], "the revoke is still attempted, and this stand-in accepts the PUT")
	assert.Empty(t, fx.store.rows)
	for _, e := range fx.trace.snapshot() {
		assert.NotContains(t, e, "store.disable", "shorted was written without a subject from BrandBrain")
	}
	assert.Contains(t, strings.Join(stringsOf(res.Structured["next_steps"]), " "), "comes from BrandBrain")
}

func TestARedirectIsRefusedAndNeverFollowed(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(target.Close)
	trace := &crawlTrace{}
	bb := &bbStandIn{redirectTo: target.URL + "/steal"}
	bbSrv := newBBStandIn(t, trace, bb)
	client, err := brandbrain.NewTestClient(bbSrv.URL, crawlToken, 0)
	require.NoError(t, err)
	store := &fakeCrawlStore{trace: trace, rows: map[string]CrawlRigRow{}}
	srv := adminStackHandler(t, &fakePublisher{fakeCrawlOp: fakeCrawlOp{store: store, grants: client, email: "ops@shorted.com.au"}})
	res := parseToolResult(t, crawlCall(t, srv, "t", CrawlAuthorizeTool, authorizeArgs(true, "")))
	assert.True(t, res.Refused)
	assert.Empty(t, store.rows)
	assert.NotContains(t, strings.Join(trace.snapshot(), " "), "store.")
}

// --- configuration ----------------------------------------------------------------

func TestWithoutTheGrantTokenTheWriteIsNotConfiguredAndTheReadStillLists(t *testing.T) {
	trace := &crawlTrace{}
	store := &fakeCrawlStore{trace: trace, rows: map[string]CrawlRigRow{
		"subj-x": {Subject: "subj-x", Enabled: true, CreatedAt: time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)},
	}}
	pub := &fakePublisher{fakeCrawlOp: fakeCrawlOp{store: store, grants: nil}}
	srv := adminStackHandler(t, pub)

	write := parseToolResult(t, crawlCall(t, srv, "t", CrawlAuthorizeTool, authorizeArgs(true, "")))
	assert.True(t, write.Refused)
	assert.Contains(t, write.Text, "BRANDBRAIN_HOUSING_GRANT_TOKEN is not configured")
	assert.Empty(t, trace.snapshot(), "the write tool touched shorted without a BrandBrain client")

	read := parseToolResult(t, crawlCall(t, srv, "t", CrawlRigsTool, `{}`))
	require.False(t, read.Refused, read.Text)
	rigs, _ := read.Structured["rigs"].([]any)
	assert.Len(t, rigs, 1)
}

// The read tool's output is closed: a row's free-text note never leaves the server.
func TestTheReadToolReturnsIdentifiersEnumsBoolsAndTimestampsOnly(t *testing.T) {
	fx := newCrawlFixture(t, &bbStandIn{granted: true}, 0)
	note := "operator note with free text"
	fx.store.rows["subj-rig-1"] = CrawlRigRow{Subject: "subj-rig-1", Enabled: true, CreatedAt: time.Date(2026, 10, 2, 3, 4, 5, 0, time.UTC)}
	fx.store.enabledNote = &note

	res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlRigsTool, `{"rig_id":"rig-1"}`))
	require.False(t, res.Refused, res.Text)
	raw, err := json.Marshal(res.Structured)
	require.NoError(t, err)
	assert.NotContains(t, string(raw), "operator note", "the note reached the read tool's output")
	assert.NotContains(t, string(raw), crawlToken, "the grant token reached the output")

	grant, _ := res.Structured["grant"].(map[string]any)
	require.NotNil(t, grant)
	assert.Equal(t, "ok", grant["brandbrain"])
	assert.Equal(t, true, grant["subject_row_present"])
	assert.Equal(t, true, grant["subject_row_enabled"])
	assert.Equal(t, "subj-rig-1", grant["workload_subject"])
}

func TestTheGrantTokenNeverAppearsInAnyResponse(t *testing.T) {
	cases := []struct {
		name string
		bb   *bbStandIn
		args string
	}{
		{"get 500", &bbStandIn{getStatus: http.StatusInternalServerError}, authorizeArgs(true, "")},
		{"put 500", &bbStandIn{putStatus: http.StatusInternalServerError}, authorizeArgs(true, "")},
		{"put 403", &bbStandIn{putStatus: http.StatusForbidden}, authorizeArgs(true, "")},
		{"get 404", &bbStandIn{getStatus: http.StatusNotFound}, authorizeArgs(true, "")},
		{"disable get 500", &bbStandIn{getStatus: http.StatusInternalServerError}, `{"rig_id":"rig-1","enabled":false}`},
	}
	for _, c := range cases {
		fx := newCrawlFixture(t, c.bb, 0)
		raw := crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, c.args)
		assert.NotContains(t, raw, crawlToken, c.name)
	}
}

// --- helpers --------------------------------------------------------------------

func stringsOf(v any) []string {
	raw, _ := v.([]any)
	out := make([]string, 0, len(raw))
	for _, x := range raw {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}
