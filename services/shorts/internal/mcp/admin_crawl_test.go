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
	// admits maps a subject to the ingest admission answer; absent means "unknown".
	admits map[string]string
}

func (f *fakeCrawlOp) CrawlIngestAdmission(_ context.Context, subject string) string {
	if v, ok := f.admits[subject]; ok {
		return v
	}
	return "unknown"
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
	// answerRigID, when set, is the rig_id the answer names (default: the rig asked for).
	answerRigID string
	// putAnswerGranted, when set, overrides the granted value a PUT answers with.
	putAnswerGranted *bool
	// putAnswerRigID and putAnswerSubject, when set, override what a PUT names.
	putAnswerRigID   string
	putAnswerSubject string
	// plain404, when set, answers 404 with a plain-text mux body rather than the contract's.
	plain404 bool
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
				writeStatus(w, cfg, cfg.getStatus)
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
			writeStatus(w, cfg, cfg.putStatus)
			return
		}
		cfg.granted = body.Granted
		if cfg.putAnswerGranted != nil {
			cfg.granted = *cfg.putAnswerGranted
		}
		rigID, subject := cfg.answerRigID, cfg.subject
		if cfg.putAnswerRigID != "" {
			rigID = cfg.putAnswerRigID
		}
		if cfg.putAnswerSubject != "" {
			subject = cfg.putAnswerSubject
		}
		writeGrantAs(w, cfg, rigID, subject)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// writeStatus answers an error. A 404 carries the contract's body unless plain404 asks for
// a route-missing page. The body never includes the token, so a leak test sees none.
func writeStatus(w http.ResponseWriter, cfg *bbStandIn, status int) {
	w.WriteHeader(status)
	switch {
	case status == http.StatusNotFound && cfg.plain404:
		_, _ = io.WriteString(w, "404 page not found")
	case status == http.StatusNotFound:
		_, _ = io.WriteString(w, `{"code":"rig_not_found","message":"no such rig"}`)
	default:
		_, _ = fmt.Fprintf(w, `{"code":"upstream","detail":"%s"}`, crawlToken)
	}
}

func writeGrant(w http.ResponseWriter, cfg *bbStandIn) {
	writeGrantAs(w, cfg, cfg.answerRigID, cfg.subject)
}

func writeGrantAs(w http.ResponseWriter, cfg *bbStandIn, answerRigID, answerSubject string) {
	reason := cfg.mintReason
	if reason == "" {
		reason = "ok"
	}
	subject := answerSubject
	if subject == "" {
		subject = "rig:rig-1"
	}
	rigID := answerRigID
	if rigID == "" {
		rigID = "rig-1"
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"rig_id": rigID, "granted": cfg.granted, "admin_state": "active", "version": "9",
		"principal_kind": "rig_token", "can_mint": reason == "ok", "can_mint_reason": reason,
		"workload_subject": subject,
	})
}

type crawlFixture struct {
	trace *crawlTrace
	store *fakeCrawlStore
	bb    *bbStandIn
	srv   *httptest.Server
	pub   *fakePublisher
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
	return &crawlFixture{trace: trace, store: store, bb: bb, srv: h, pub: pub}
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
	fx.store.rows["rig:rig-1"] = CrawlRigRow{Subject: "rig:rig-1", Enabled: true}
	raw := crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, `{"rig_id":"rig-1","enabled":false}`)
	res := parseToolResult(t, raw)
	require.False(t, res.Refused, raw)
	assert.Equal(t, "disabled", res.Structured["shorted"])
}

// --- sequencing ------------------------------------------------------------------

func TestEnableRunsGetPutThenTheShortedWriteForTheServersSubject(t *testing.T) {
	fx := newCrawlFixture(t, &bbStandIn{subject: "rig:rig-1"}, 0)
	raw := crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, authorizeArgs(true, `,"note":"  the Sydney rig  "`))
	res := parseToolResult(t, raw)
	require.False(t, res.Refused, raw)

	assert.Equal(t, []string{
		"bb.GET",
		"bb.PUT granted=true operator=ops@shorted.com.au",
		"store.enable rig:rig-1",
	}, fx.trace.snapshot())
	require.NotNil(t, fx.store.enabledNote)
	assert.Equal(t, "the Sydney rig", *fx.store.enabledNote, "the note is trimmed")
	assert.Equal(t, "enabled", res.Structured["shorted"])
	assert.Equal(t, "granted", res.Structured["brandbrain"])
	assert.Equal(t, true, res.Structured["can_mint"])
	assert.Equal(t, "rig:rig-1", res.Structured["workload_subject"])
}

// --- BrandBrain's answer decides nothing about which row is written -----------------

// The answer's subject is not rig:<rig_id>. Enabling must write nothing, not even for the
// subject the answer names.
func TestEnableAgainstAVictimSubjectWritesNothing(t *testing.T) {
	fx := newCrawlFixture(t, &bbStandIn{subject: "rig:victim"}, 0)
	res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, authorizeArgs(true, "")))
	require.False(t, res.Refused, res.Text)
	assert.Equal(t, "invalid", res.Structured["brandbrain"])
	assert.Equal(t, "unchanged", res.Structured["shorted"])
	assert.Empty(t, fx.store.rows, "enable wrote a row for a subject BrandBrain named")
	for _, e := range fx.trace.snapshot() {
		assert.NotContains(t, e, "store.", "shorted was written from a mismatched answer")
		assert.NotContains(t, e, "bb.PUT", "a PUT was sent after an invalid GET")
	}
}

// The answer names another rig_id. Enabling rig-1 writes nothing for it.
func TestEnableAgainstAnotherRigIDWritesNothing(t *testing.T) {
	fx := newCrawlFixture(t, &bbStandIn{answerRigID: "rig-2", subject: "rig:rig-2"}, 0)
	res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, authorizeArgs(true, "")))
	require.False(t, res.Refused, res.Text)
	assert.Equal(t, "invalid", res.Structured["brandbrain"])
	assert.Empty(t, fx.store.rows)
	for _, e := range fx.trace.snapshot() {
		assert.NotContains(t, e, "store.")
	}
}

// Disabling rig-1 whose answer names a bystander's subject never touches that row.
func TestDisableRigIDNeverTouchesABystanderRow(t *testing.T) {
	fx := newCrawlFixture(t, &bbStandIn{granted: true, subject: "rig:victim"}, 0)
	fx.store.rows["rig:victim"] = CrawlRigRow{Subject: "rig:victim", Enabled: true}
	fx.store.rows["rig:rig-1"] = CrawlRigRow{Subject: "rig:rig-1", Enabled: true}
	res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, `{"rig_id":"rig-1","enabled":false}`))
	require.False(t, res.Refused, res.Text)
	assert.True(t, fx.store.rows["rig:victim"].Enabled, "a bystander's row was disabled")
	for _, e := range fx.trace.snapshot() {
		assert.NotContains(t, e, "rig:victim", "the bystander's subject reached shorted")
	}
	assert.Equal(t, "failed", res.Structured["shorted"], "the subject is unresolved, so shorted's row is not written")
}

// A PUT answer that says granted:false to an enable is not a confirmed grant: unknown,
// and shorted is not written.
func TestEnableWhosePutAnswersGrantedFalseIsUnknown(t *testing.T) {
	no := false
	fx := newCrawlFixture(t, &bbStandIn{putAnswerGranted: &no}, 0)
	res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, authorizeArgs(true, "")))
	require.False(t, res.Refused, res.Text)
	assert.Equal(t, "unknown", res.Structured["brandbrain"])
	assert.Equal(t, "unchanged", res.Structured["shorted"])
	assert.Empty(t, fx.store.rows, "shorted was written after a PUT that did not confirm the grant")
}

// A PUT answer that names another rig, or another subject, is not a confirmation either.
func TestEnableWhosePutNamesAnotherRigOrSubjectIsUnknown(t *testing.T) {
	for name, bb := range map[string]*bbStandIn{
		"other rig_id":  {putAnswerRigID: "rig-9"},
		"other subject": {putAnswerSubject: "rig:victim"},
	} {
		fx := newCrawlFixture(t, bb, 0)
		res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, authorizeArgs(true, "")))
		require.False(t, res.Refused, "%s: %s", name, res.Text)
		assert.Equal(t, "unknown", res.Structured["brandbrain"], name)
		assert.Equal(t, "unchanged", res.Structured["shorted"], name)
		assert.Empty(t, fx.store.rows, "%s: shorted was written after a PUT that named another rig or subject", name)
	}
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
	fx.store.rows["rig:rig-1"] = CrawlRigRow{Subject: "rig:rig-1", Enabled: true}
	res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, `{"rig_id":"rig-1","enabled":false}`))
	require.False(t, res.Refused)
	assert.Equal(t, []string{
		"bb.GET",
		"store.disable rig:rig-1",
		"bb.PUT granted=false operator=ops@shorted.com.au",
	}, fx.trace.snapshot())
	assert.Equal(t, "revoked", res.Structured["brandbrain"])
}

func TestDisableUpdatesShortedBeforeAPutThatFails(t *testing.T) {
	fx := newCrawlFixture(t, &bbStandIn{granted: true, putStatus: http.StatusServiceUnavailable}, 0)
	fx.store.rows["rig:rig-1"] = CrawlRigRow{Subject: "rig:rig-1", Enabled: true}
	res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, `{"rig_id":"rig-1","enabled":false}`))
	require.False(t, res.Refused)
	events := fx.trace.snapshot()
	require.Len(t, events, 3)
	assert.Equal(t, "store.disable rig:rig-1", events[1], "shorted must be written before the revoke is attempted")
	assert.Equal(t, "disabled", res.Structured["shorted"])
	assert.Equal(t, "unknown", res.Structured["brandbrain"], "a 5xx on the PUT is an unknown outcome")
	assert.False(t, fx.store.rows["rig:rig-1"].Enabled)
}

func TestDisableRevokesEvenWhenTheShortedWriteFails(t *testing.T) {
	fx := newCrawlFixture(t, &bbStandIn{granted: true}, 0)
	fx.store.rows["rig:rig-1"] = CrawlRigRow{Subject: "rig:rig-1", Enabled: true}
	fx.store.disableErr = errors.New("connection reset")
	res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, `{"rig_id":"rig-1","enabled":false}`))
	require.False(t, res.Refused)
	assert.Equal(t, "failed", res.Structured["shorted"])
	assert.Equal(t, "revoked", res.Structured["brandbrain"])
	assert.Contains(t, fx.trace.snapshot(), "bb.PUT granted=false operator=ops@shorted.com.au")
}

func TestRepeatedDisableIsUnchanged(t *testing.T) {
	fx := newCrawlFixture(t, &bbStandIn{granted: false}, 0)
	fx.store.rows["rig:rig-1"] = CrawlRigRow{Subject: "rig:rig-1", Enabled: false}
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
	assert.Contains(t, strings.Join(stringsOf(res.Structured["next_steps"]), " "),
		"BrandBrain could not be reached to resolve the subject; disable shorted's side by subject: call again with subject from housing_crawl_rigs")
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
	fx.store.rows["rig:rig-1"] = CrawlRigRow{Subject: "rig:rig-1", Enabled: true, CreatedAt: time.Date(2026, 10, 2, 3, 4, 5, 0, time.UTC)}
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
	assert.Equal(t, "rig:rig-1", grant["workload_subject"])
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

// --- disable by subject (the kill switch) -----------------------------------------

// BrandBrain down: a disable by subject changes shorted's row and never calls BrandBrain.
func TestDisableBySubjectWorksWithBrandBrainDown(t *testing.T) {
	fx := newCrawlFixture(t, &bbStandIn{getStatus: http.StatusServiceUnavailable, putStatus: http.StatusServiceUnavailable}, 0)
	fx.store.rows["rig:rig-1"] = CrawlRigRow{Subject: "rig:rig-1", Enabled: true}
	raw := crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, `{"subject":"rig:rig-1","enabled":false}`)
	res := parseToolResult(t, raw)
	require.False(t, res.Refused, raw)
	assert.Equal(t, "disabled", res.Structured["shorted"])
	assert.Equal(t, "not_attempted", res.Structured["brandbrain"])
	assert.Equal(t, []string{"store.disable rig:rig-1"}, fx.trace.snapshot(), "BrandBrain was called on a subject disable")
	assert.False(t, fx.store.rows["rig:rig-1"].Enabled)
}

// With its token unset there is no BrandBrain client at all. The kill switch still works.
func TestDisableBySubjectWorksWhenTheGrantTokenIsUnset(t *testing.T) {
	trace := &crawlTrace{}
	store := &fakeCrawlStore{trace: trace, rows: map[string]CrawlRigRow{"rig:rig-1": {Subject: "rig:rig-1", Enabled: true}}}
	srv := adminStackHandler(t, &fakePublisher{fakeCrawlOp: fakeCrawlOp{store: store, grants: nil}})
	res := parseToolResult(t, crawlCall(t, srv, "t", CrawlAuthorizeTool, `{"subject":"rig:rig-1","enabled":false}`))
	require.False(t, res.Refused, res.Text)
	assert.Equal(t, "disabled", res.Structured["shorted"])
	assert.Equal(t, "not_attempted", res.Structured["brandbrain"])
}

func TestDisableBySubjectWithoutARowReportsNotPresent(t *testing.T) {
	fx := newCrawlFixture(t, nil, 0)
	res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, `{"subject":"rig:ghost","enabled":false}`))
	require.False(t, res.Refused)
	assert.Equal(t, "not_present", res.Structured["shorted"])
	assert.Empty(t, fx.store.rows, "a subject disable created a row")
}

// Enabling needs rig_id. A subject is never enough to turn a rig on.
func TestEnableWithASubjectIsRefused(t *testing.T) {
	for name, args := range map[string]string{
		"with confirm":    `{"subject":"rig:rig-1","enabled":true,"confirm":true}`,
		"without confirm": `{"subject":"rig:rig-1","enabled":true}`,
	} {
		fx := newCrawlFixture(t, nil, 0)
		res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, args))
		assert.True(t, res.Refused, "%s: enable by subject was accepted", name)
		assert.Contains(t, res.Text, "needs rig_id", name)
		assert.Empty(t, fx.trace.snapshot(), "%s: an enable by subject reached a side effect", name)
	}
}

func TestExactlyOneOfRigIDOrSubject(t *testing.T) {
	for name, args := range map[string]string{
		"both":         `{"rig_id":"rig-1","subject":"rig:rig-1","enabled":false}`,
		"neither":      `{"enabled":false}`,
		"both, enable": `{"rig_id":"rig-1","subject":"rig:rig-1","enabled":true,"confirm":true}`,
	} {
		fx := newCrawlFixture(t, nil, 0)
		res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, args))
		assert.True(t, res.Refused, "%s was accepted", name)
		assert.Empty(t, fx.trace.snapshot(), "%s reached a side effect", name)
	}
}

func TestBadSubjectsAreRefused(t *testing.T) {
	long := "rig:" + strings.Repeat("a", 101) // 101 id characters: one too many
	ok := "rig:" + strings.Repeat("a", 100)   // the issuer's maximum: 1 leading + 99
	bad := []string{
		"rig-1",      // no prefix
		"subj-rig-1", // not the issuer's form
		"RIG:rig-1",  // prefix is lower-case
		"rig:",       // empty id
		"rig:-x",     // id must start with a letter or digit
		"rig:a b",    // space
		"rig:../x",   // path
		"rig:a/b",    // slash
		"rig:a@b",    // not in the id charset
		long,         // id 101 characters
		"rig:x\n",    // control character
	}
	for _, sub := range bad {
		fx := newCrawlFixture(t, nil, 0)
		args := fmt.Sprintf(`{"subject":%q,"enabled":false}`, sub)
		res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, args))
		assert.True(t, res.Refused, "subject %q was accepted", sub)
		assert.Empty(t, fx.trace.snapshot(), "subject %q reached a side effect", sub)
	}
	// The longest legal id is accepted.
	fx := newCrawlFixture(t, nil, 0)
	res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, fmt.Sprintf(`{"subject":%q,"enabled":false}`, ok)))
	assert.False(t, res.Refused, res.Text)
}

// --- ingest admission (an operator signal, never a gate) -----------------------------

func TestEnableReportsAdmissionAndNamesTheRemainingAction(t *testing.T) {
	fx := newCrawlFixture(t, nil, 0)
	fx.pub.admits = map[string]string{"rig:rig-1": "false"}
	res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, authorizeArgs(true, "")))
	require.False(t, res.Refused, res.Text)
	// The change still lands on both sides: admission never refuses it.
	assert.Equal(t, "enabled", res.Structured["shorted"])
	assert.Equal(t, "granted", res.Structured["brandbrain"])
	assert.Equal(t, "false", res.Structured["ingest_admits"])
	steps := strings.Join(stringsOf(res.Structured["next_steps"]), " ")
	assert.Contains(t, steps, "add rig:rig-1 to ingest_allow_subjects and set ingest_org in terraform/environments/prod (module housing_ingest), then deploy")
	assert.NotContains(t, steps, "admitted within a minute", "the old overstated next step survived")
}

func TestEnableReportsAdmissionTrueAndUnknown(t *testing.T) {
	fx := newCrawlFixture(t, nil, 0)
	fx.pub.admits = map[string]string{"rig:rig-1": "true"}
	res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, authorizeArgs(true, "")))
	assert.Equal(t, "true", res.Structured["ingest_admits"])
	assert.Contains(t, strings.Join(stringsOf(res.Structured["next_steps"]), " "), "admitted")

	fx = newCrawlFixture(t, nil, 0) // no admission answer: unknown
	res = parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, authorizeArgs(true, "")))
	assert.Equal(t, "unknown", res.Structured["ingest_admits"])
	assert.Contains(t, strings.Join(stringsOf(res.Structured["next_steps"]), " "), "could not be read")
}

// Disable must never depend on admission: a subject disable works when the ingest is
// unreadable, and so does a rig disable.
func TestDisableDoesNotDependOnAdmission(t *testing.T) {
	fx := newCrawlFixture(t, &bbStandIn{granted: true}, 0)
	fx.store.rows["rig:rig-1"] = CrawlRigRow{Subject: "rig:rig-1", Enabled: true}
	res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, `{"subject":"rig:rig-1","enabled":false}`))
	require.False(t, res.Refused, res.Text)
	assert.Equal(t, "disabled", res.Structured["shorted"])
	assert.Equal(t, "unknown", res.Structured["ingest_admits"])

	fx = newCrawlFixture(t, &bbStandIn{granted: true}, 0)
	fx.store.rows["rig:rig-1"] = CrawlRigRow{Subject: "rig:rig-1", Enabled: true}
	res = parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, `{"rig_id":"rig-1","enabled":false}`))
	require.False(t, res.Refused, res.Text)
	assert.Equal(t, "disabled", res.Structured["shorted"])
	assert.Equal(t, "revoked", res.Structured["brandbrain"])
}

// --- 404 that is not the contract's rig_not_found ------------------------------------

// A route that is not deployed answers a plain 404. A disable by rig_id then cannot resolve
// the subject: it attempts the revoke, reports shorted failed, and says to disable by subject.
func TestDisableByRigIDOnAPlain404FallsBackToSubject(t *testing.T) {
	fx := newCrawlFixture(t, &bbStandIn{plain404: true, getStatus: http.StatusNotFound, granted: true}, 0)
	fx.store.rows["rig:rig-1"] = CrawlRigRow{Subject: "rig:rig-1", Enabled: true}
	res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, `{"rig_id":"rig-1","enabled":false}`))
	require.False(t, res.Refused, res.Text)
	assert.Equal(t, "failed", res.Structured["shorted"])
	assert.Equal(t, "revoked", res.Structured["brandbrain"], "the revoke PUT is still attempted when the subject is unresolved")
	assert.Contains(t, fx.trace.snapshot(), "bb.PUT granted=false operator=ops@shorted.com.au")
	assert.True(t, fx.store.rows["rig:rig-1"].Enabled, "shorted changed without a resolved subject")
	assert.Contains(t, strings.Join(stringsOf(res.Structured["next_steps"]), " "),
		"BrandBrain could not be reached to resolve the subject; disable shorted's side by subject: call again with subject from housing_crawl_rigs")
}

// The same plain 404 on enable is an unknown outcome, never "rig not found", and writes nothing.
func TestEnableOnAPlain404WritesNothing(t *testing.T) {
	fx := newCrawlFixture(t, &bbStandIn{plain404: true, getStatus: http.StatusNotFound}, 0)
	res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, authorizeArgs(true, "")))
	assert.True(t, res.Refused)
	assert.NotContains(t, res.Text, "rig_not_found")
	assert.Empty(t, fx.store.rows)
	assert.Equal(t, []string{"bb.GET"}, fx.trace.snapshot())
}

// --- rig_id pattern is BrandBrain's exactly ----------------------------------------

func TestRigIDPatternMatchesTheIssuer(t *testing.T) {
	ok := []string{"a", "rig-1", "R.9_x", strings.Repeat("a", 100)}
	bad := []string{"", "-x", ".x", "_x", strings.Repeat("a", 101), "a b", "a/b", "a@b"}
	for _, id := range ok {
		assert.True(t, crawlRigIDPattern.MatchString(id), "%q refused", id)
	}
	for _, id := range bad {
		assert.False(t, crawlRigIDPattern.MatchString(id), "%q accepted", id)
	}
}

// --- the answer's rig half and subject half are both required ------------------------

// The answer names rig-2 but a subject of rig:rig-1. Only the rig half catches this one.
func TestEnableWhenTheAnswerNamesAnotherRigWithOurSubjectWritesNothing(t *testing.T) {
	fx := newCrawlFixture(t, &bbStandIn{answerRigID: "rig-2", subject: "rig:rig-1"}, 0)
	res := parseToolResult(t, crawlCall(t, fx.srv, "t", CrawlAuthorizeTool, authorizeArgs(true, "")))
	require.False(t, res.Refused, res.Text)
	assert.Equal(t, "invalid", res.Structured["brandbrain"])
	assert.Empty(t, fx.store.rows)
}
