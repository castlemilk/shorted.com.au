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

func adminClaims() *VerifiedClaims {
	return &VerifiedClaims{
		UserID:    "uid-admin",
		Scopes:    []string{"news:publish"},
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
func adminStack(t *testing.T, validator ClaimsValidator, check AdminCheck, pub AdminPublisher) *httptest.Server {
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

func TestATokenWithoutNewsPublishIsRefused(t *testing.T) {
	claims := adminClaims()
	claims.Scopes = []string{"shorts:read"}
	pub := &fakePublisher{}
	srv := adminStack(t, stubClaims{claims: claims}, onlyAdmin("uid-admin"), pub)
	resp, _ := adminCall(t, srv, "t", publishCall)
	if resp.StatusCode != http.StatusForbidden || pub.req.Slug != "" {
		t.Fatalf("status = %d; want 403 insufficient scope", resp.StatusCode)
	}
}

// A valid admin token for someone who is no longer an admin: refused NOW, not
// when the token expires.
func TestARevokedAdminIsRefusedEvenWithAValidToken(t *testing.T) {
	for name, check := range map[string]AdminCheck{
		"not an admin":   onlyAdmin("someone-else"),
		"lookup failure": func(context.Context, string) (bool, error) { return false, errors.New("down") },
		"no check":       nil,
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

	if len(admin) != 2 || admin["publish_news_article"] == nil || admin["news_publish_status"] == nil {
		t.Fatalf("admin tools = %v", admin)
	}
	for name := range admin {
		if public[name] != nil {
			t.Errorf("admin tool %s is on the PUBLIC server", name)
		}
	}
	// The write tool must not claim to be read-only.
	if admin["publish_news_article"].Annotations == nil || admin["publish_news_article"].Annotations.ReadOnlyHint {
		t.Error("publish_news_article is annotated read-only")
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
	if strings.Contains(string(raw), "shorts:read") || !strings.Contains(string(raw), "news:publish") {
		t.Fatalf("admin PRM = %s", raw)
	}
}
