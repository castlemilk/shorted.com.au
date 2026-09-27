package mcp

// The admin MCP server as a real client meets it: over a socket, through the
// same middleware stack serve.go mounts (RequireBearerToken → RequireAdmin →
// AdminHandler).

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	sdkauth "github.com/modelcontextprotocol/go-sdk/auth"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/jobmonitor"
)

type fakePublisher struct {
	req    jobmonitor.PublishRequest
	runErr error
	exec   string
	// picks records the picks half.
	picks     jobmonitor.PicksRequest
	picksErr  error
	picksExec string
}

func (f *fakePublisher) RunPublish(_ context.Context, req jobmonitor.PublishRequest) (*jobmonitor.PublishRun, error) {
	f.req = req
	if f.runErr != nil {
		return nil, f.runErr
	}
	return &jobmonitor.PublishRun{
		Job: "shorted-news-publish", ExecutionName: "shorted-news-publish-ab12c", Slug: req.Slug,
		Args: []string{"publish-content", "--slug=" + req.Slug}, URL: "https://shorted.com.au/news/" + req.Slug,
	}, nil
}

func (f *fakePublisher) PublishResult(_ context.Context, execution string) (*jobmonitor.PublishStatus, error) {
	f.exec = execution
	return &jobmonitor.PublishStatus{ExecutionName: execution, Status: "succeeded"}, nil
}

func (f *fakePublisher) RunPicks(_ context.Context, req jobmonitor.PicksRequest) (*jobmonitor.PicksRun, error) {
	f.picks = req
	if f.picksErr != nil {
		return nil, f.picksErr
	}
	mode, err := jobmonitor.NormalizePicksMode(req.Mode)
	if err != nil {
		return nil, err
	}
	return &jobmonitor.PicksRun{
		Job: "shorted-picks", Region: "australia-southeast2", ExecutionName: "shorted-picks-p1ck5",
		Mode: mode, Args: []string{"picks", "-mode", string(mode)},
	}, nil
}

func (f *fakePublisher) PicksResult(_ context.Context, execution string) (*jobmonitor.ExecutionStatus, error) {
	f.picksExec = execution
	return &jobmonitor.ExecutionStatus{ExecutionName: execution, Status: "running", StartedAt: "2026-09-27T10:00:00Z"}, nil
}

// adminClaims is a token granted the WHOLE admin vocabulary — what an empty
// scope request against /mcp/admin is minted with.
func adminClaims() *VerifiedClaims {
	return &VerifiedClaims{
		UserID:    "uid-admin",
		Scopes:    append([]string(nil), AdminScopes...),
		Audience:  []string{AdminResourceURI(conformanceOrigin)},
		ExpiresAt: time.Now().Add(time.Hour),
	}
}

func onlyAdmin(ids ...string) AdminCheck {
	return func(_ context.Context, uid string) (bool, error) {
		for _, id := range ids {
			if id == uid {
				return true, nil
			}
		}
		return false, nil
	}
}

// adminStack composes EXACTLY as serve.go does.
func adminStack(t *testing.T, validator ClaimsValidator, check AdminCheck, pub AdminOperator) *httptest.Server {
	t.Helper()
	h := sdkauth.RequireBearerToken(
		NewTokenVerifier(validator, AdminResourceURI(conformanceOrigin)),
		AdminBearerTokenOptions(conformanceOrigin),
	)(RequireAdmin(check)(AdminHandler(pub)))
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv
}

func adminCall(t *testing.T, srv *httptest.Server, token, body string) (*http.Response, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/mcp/admin", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	raw, _ := io.ReadAll(resp.Body)
	return resp, string(raw)
}

const publishCall = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"publish_news_article","arguments":{"slug":"us-bond-rout-australia-banks-property-shorts"}}}`

// There is no anonymous path: the first request is a 401 whose challenge names
// the ADMIN metadata document — which is what sends a connector through OAuth.
func TestAdminServerChallengesAnonymousCallersWithItsOwnMetadata(t *testing.T) {
	pub := &fakePublisher{}
	srv := adminStack(t, stubClaims{claims: adminClaims()}, onlyAdmin("uid-admin"), pub)
	resp, _ := adminCall(t, srv, "", publishCall)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}
	challenge := resp.Header.Get("WWW-Authenticate")
	if !strings.Contains(challenge, AdminProtectedResourceMetadataURL(conformanceOrigin)) {
		t.Fatalf("challenge %q does not name the admin metadata document", challenge)
	}
	if pub.req.Slug != "" {
		t.Fatal("an anonymous call reached the publisher")
	}
}

// A token for the PUBLIC server is not a token for this one.
func TestAPublicMCPTokenIsRefusedOnTheAdminServer(t *testing.T) {
	claims := adminClaims()
	claims.Audience = []string{ResourceURI(conformanceOrigin)}
	pub := &fakePublisher{}
	srv := adminStack(t, stubClaims{claims: claims}, onlyAdmin("uid-admin"), pub)
	resp, _ := adminCall(t, srv, "public-token", publishCall)
	if resp.StatusCode != http.StatusUnauthorized || pub.req.Slug != "" {
		t.Fatalf("status = %d, published = %q; want 401 and nothing", resp.StatusCode, pub.req.Slug)
	}
}

func TestATokenWithoutAnyAdminScopeIsRefused(t *testing.T) {
	for name, scopes := range map[string][]string{"read scope only": {"shorts:read"}, "no scopes": nil} {
		claims := adminClaims()
		claims.Scopes = scopes
		pub := &fakePublisher{}
		srv := adminStack(t, stubClaims{claims: claims}, onlyAdmin("uid-admin"), pub)
		resp, _ := adminCall(t, srv, "t", publishCall)
		if resp.StatusCode != http.StatusForbidden || pub.req.Slug != "" {
			t.Fatalf("%s: status = %d; want 403 insufficient scope", name, resp.StatusCode)
		}
	}
}

const runPicksCall = `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"run_picks_job","arguments":{"mode":"fundamentals"}}}`

// A connector authorised before jobs:run existed keeps its publish tools and is
// told, per tool, to reconnect for the new scope — it is not logged out.
func TestScopesAreCheckedPerToolNotPerConnection(t *testing.T) {
	publishOnly := adminClaims()
	publishOnly.Scopes = []string{ScopeNewsPublish}
	pub := &fakePublisher{}
	srv := adminStack(t, stubClaims{claims: publishOnly}, onlyAdmin("uid-admin"), pub)

	resp, body := adminCall(t, srv, "t", runPicksCall)
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"isError":true`) || !strings.Contains(body, "jobs:run") {
		t.Fatalf("status = %d body = %s; want a tool error naming jobs:run", resp.StatusCode, body)
	}
	if pub.picks.Mode != "" {
		t.Fatalf("a publish-only token started a picks run: %+v", pub.picks)
	}
	if resp, body := adminCall(t, srv, "t", publishCall); resp.StatusCode != http.StatusOK || strings.Contains(body, `"isError":true`) {
		t.Fatalf("the same token lost publish: %d %s", resp.StatusCode, body)
	}

	jobsOnly := adminClaims()
	jobsOnly.Scopes = []string{ScopeJobsRun}
	pub = &fakePublisher{}
	srv = adminStack(t, stubClaims{claims: jobsOnly}, onlyAdmin("uid-admin"), pub)
	if resp, body := adminCall(t, srv, "t", publishCall); resp.StatusCode != http.StatusOK || !strings.Contains(body, "news:publish") || pub.req.Slug != "" {
		t.Fatalf("a jobs-only token reached publish: %d %s (slug %q)", resp.StatusCode, body, pub.req.Slug)
	}
	if resp, body := adminCall(t, srv, "t", runPicksCall); resp.StatusCode != http.StatusOK || strings.Contains(body, `"isError":true`) {
		t.Fatalf("a jobs-only token could not run picks: %d %s", resp.StatusCode, body)
	}
}

func TestAnAdminCanRunPicksAndTheCallIsAttributed(t *testing.T) {
	pub := &fakePublisher{}
	srv := adminStack(t, stubClaims{claims: adminClaims()}, onlyAdmin("uid-admin"), pub)
	resp, body := adminCall(t, srv, "t", runPicksCall)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d: %s", resp.StatusCode, body)
	}
	if pub.picks.Mode != "fundamentals" || pub.picks.Force || pub.picks.Actor != "oauth:uid-admin" {
		t.Fatalf("picks request = %+v", pub.picks)
	}
	if !strings.Contains(body, "shorted-picks-p1ck5") || !strings.Contains(body, "picks -mode fundamentals") {
		t.Fatalf("response lacks the execution name or the constructed argv: %s", body)
	}
	// The runbook rides along: after fundamentals comes filings, then refresh.
	if !strings.Contains(body, "run filings, then refresh") {
		t.Fatalf("response lacks the next step: %s", body)
	}
}

func TestPicksRefusalsReachTheModelAsToolErrors(t *testing.T) {
	// An invalid mode is refused by the monitor before GCP, with the enum.
	pub := &fakePublisher{}
	srv := adminStack(t, stubClaims{claims: adminClaims()}, onlyAdmin("uid-admin"), pub)
	bad := `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"run_picks_job","arguments":{"mode":"refresh -codes BHP"}}}`
	resp, body := adminCall(t, srv, "t", bad)
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"isError":true`) || !strings.Contains(body, "fundamentals|filings|refresh|all") {
		t.Fatalf("status = %d body = %s; want a tool error listing the modes", resp.StatusCode, body)
	}

	pub = &fakePublisher{picksErr: &jobmonitor.AlreadyRunningError{Job: "shorted-picks", ExecutionName: "shorted-picks-old"}}
	srv = adminStack(t, stubClaims{claims: adminClaims()}, onlyAdmin("uid-admin"), pub)
	resp, body = adminCall(t, srv, "t", runPicksCall)
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"isError":true`) || !strings.Contains(body, "force=true") {
		t.Fatalf("status = %d body = %s; want a tool error naming force", resp.StatusCode, body)
	}
}

func TestPicksStatusPollsTheNamedExecution(t *testing.T) {
	pub := &fakePublisher{}
	srv := adminStack(t, stubClaims{claims: adminClaims()}, onlyAdmin("uid-admin"), pub)
	call := `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"picks_job_status","arguments":{"execution_name":"shorted-picks-p1ck5"}}}`
	resp, body := adminCall(t, srv, "t", call)
	if resp.StatusCode != http.StatusOK || pub.picksExec != "shorted-picks-p1ck5" || !strings.Contains(body, "running") {
		t.Fatalf("status = %d exec = %q body = %s", resp.StatusCode, pub.picksExec, body)
	}
}

// A lookup that FAILS is not a "no": it must not read as an authorization
// failure (a client drops its sign-in on those), and it must not let the
// request through either.
func TestAFailedAdminLookupIsRetryableNotForbidden(t *testing.T) {
	pub := &fakePublisher{}
	down := func(context.Context, string) (bool, error) { return false, errors.New("down") }
	srv := adminStack(t, stubClaims{claims: adminClaims()}, down, pub)
	resp, _ := adminCall(t, srv, "t", publishCall)
	if resp.StatusCode != http.StatusServiceUnavailable || resp.Header.Get("Retry-After") == "" || pub.req.Slug != "" {
		t.Fatalf("status = %d retry-after = %q published = %q; want 503 + Retry-After and nothing",
			resp.StatusCode, resp.Header.Get("Retry-After"), pub.req.Slug)
	}
}

// A valid admin token for someone who is no longer an admin: refused NOW, not
// when the token expires.
func TestARevokedAdminIsRefusedEvenWithAValidToken(t *testing.T) {
	for name, check := range map[string]AdminCheck{
		"not an admin": onlyAdmin("someone-else"),
		"no check":     nil,
	} {
		pub := &fakePublisher{}
		srv := adminStack(t, stubClaims{claims: adminClaims()}, check, pub)
		resp, _ := adminCall(t, srv, "t", publishCall)
		if resp.StatusCode != http.StatusForbidden || pub.req.Slug != "" {
			t.Fatalf("%s: status = %d, published = %q; want 403 and nothing", name, resp.StatusCode, pub.req.Slug)
		}
	}
}

func TestAnAdminCanPublishAndTheCallIsAttributed(t *testing.T) {
	pub := &fakePublisher{}
	srv := adminStack(t, stubClaims{claims: adminClaims()}, onlyAdmin("uid-admin"), pub)
	resp, body := adminCall(t, srv, "t", publishCall)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d: %s", resp.StatusCode, body)
	}
	if pub.req.Slug != "us-bond-rout-australia-banks-property-shorts" || pub.req.SkipImages || pub.req.Force {
		t.Fatalf("publish request = %+v", pub.req)
	}
	if pub.req.Actor != "oauth:uid-admin" {
		t.Fatalf("actor = %q, want the token's subject", pub.req.Actor)
	}
	if !strings.Contains(body, "shorted-news-publish-ab12c") {
		t.Fatalf("response lacks the execution name: %s", body)
	}
}

func TestPublishRefusalsReachTheModelAsToolErrors(t *testing.T) {
	pub := &fakePublisher{runErr: &jobmonitor.AlreadyRunningError{Job: "shorted-news-publish", ExecutionName: "x"}}
	srv := adminStack(t, stubClaims{claims: adminClaims()}, onlyAdmin("uid-admin"), pub)
	resp, body := adminCall(t, srv, "t", publishCall)
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"isError":true`) || !strings.Contains(body, "force=true") {
		t.Fatalf("status = %d body = %s; want a tool error naming force", resp.StatusCode, body)
	}
}

func TestPublishStatusPollsTheNamedExecution(t *testing.T) {
	pub := &fakePublisher{}
	srv := adminStack(t, stubClaims{claims: adminClaims()}, onlyAdmin("uid-admin"), pub)
	call := `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"news_publish_status","arguments":{"execution_name":"shorted-news-publish-ab12c"}}}`
	resp, body := adminCall(t, srv, "t", call)
	if resp.StatusCode != http.StatusOK || pub.exec != "shorted-news-publish-ab12c" || !strings.Contains(body, "succeeded") {
		t.Fatalf("status = %d exec = %q body = %s", resp.StatusCode, pub.exec, body)
	}
}

// The admin server lists exactly its own tools — none of the public ones — and
// the public server lists none of the admin ones.
func TestAdminAndPublicToolSetsAreDisjoint(t *testing.T) {
	ctx := context.Background()
	names := func(server *sdk.Server) map[string]*sdk.Tool {
		t.Helper()
		clientT, serverT := sdk.NewInMemoryTransports()
		if _, err := server.Connect(ctx, serverT, nil); err != nil {
			t.Fatal(err)
		}
		session, err := sdk.NewClient(&sdk.Implementation{Name: "t", Version: "1"}, nil).Connect(ctx, clientT, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = session.Close() }()
		res, err := session.ListTools(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		out := map[string]*sdk.Tool{}
		for _, tool := range res.Tools {
			out[tool.Name] = tool
		}
		return out
	}
	admin := names(NewAdminServer(&fakePublisher{}))
	public := names(NewServer(&fakeDataSource{}))

	if len(admin) != len(AdminRegistry()) {
		t.Fatalf("admin tools = %v", admin)
	}
	for _, at := range AdminRegistry() {
		if admin[at.Name] == nil {
			t.Errorf("admin tool %s is not listed", at.Name)
		}
		if !slices.Contains(AdminScopes, at.Scope) {
			t.Errorf("admin tool %s requires %q, which is not an admin scope", at.Name, at.Scope)
		}
	}
	for name := range admin {
		if public[name] != nil {
			t.Errorf("admin tool %s is on the PUBLIC server", name)
		}
	}
	// The write tools must not claim to be read-only.
	for _, name := range []string{"publish_news_article", "run_picks_job"} {
		if admin[name].Annotations == nil || admin[name].Annotations.ReadOnlyHint {
			t.Errorf("%s is annotated read-only", name)
		}
	}
}

// The admin scope is kept OUT of the public vocabulary: the public default
// grant, the public PRM and the ":read" invariant all depend on it.
func TestAdminScopeIsNotInThePublicVocabulary(t *testing.T) {
	for _, s := range Scopes {
		for _, a := range AdminScopes {
			if s == a {
				t.Fatalf("%s is in the public Scopes", a)
			}
		}
	}
	prm := AdminProtectedResourceMetadata(conformanceOrigin)
	if prm.Resource != conformanceOrigin+"/mcp/admin" {
		t.Fatalf("admin PRM resource = %q", prm.Resource)
	}
	raw, _ := json.Marshal(prm)
	if strings.Contains(string(raw), "shorts:read") || !strings.Contains(string(raw), "news:publish") || !strings.Contains(string(raw), "jobs:run") {
		t.Fatalf("admin PRM = %s", raw)
	}
	for _, a := range AdminScopes {
		if strings.HasSuffix(a, ":read") {
			t.Errorf("admin scope %s reads as a public read scope", a)
		}
	}
}
