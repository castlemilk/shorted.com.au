package brandbrain

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
)

const testToken = "bb-test-token-DO-NOT-LEAK-7f3a"

func newServer(t *testing.T, h http.HandlerFunc) (*httptest.Server, *Client) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	c, err := NewTestClient(srv.URL, testToken, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	return srv, c
}

func TestGetGrantParsesTheContract(t *testing.T) {
	var gotAuth, gotPath string
	_, c := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotPath = r.Header.Get("Authorization"), r.URL.Path
		_, _ = io.WriteString(w, `{"rig_id":"rig-1","granted":true,"admin_state":"active","version":"9","principal_kind":"rig_token","can_mint":true,"can_mint_reason":"ok","workload_subject":"subj-rig-1"}`)
	})
	g, err := c.GetGrant(context.Background(), "rig-1")
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/api/v1/fleet/rigs/rig-1/housing-crawl/grant" || gotAuth != "Bearer "+testToken {
		t.Fatalf("path %q auth %q", gotPath, gotAuth)
	}
	if !g.Granted || !g.CanMint || g.WorkloadSubject != "subj-rig-1" || g.CanMintReason != "ok" {
		t.Fatalf("grant = %+v", g)
	}
}

func TestPutGrantSendsTheClosedBodyAndOperatorHeader(t *testing.T) {
	var body, operator, method string
	_, c := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		method = r.Method
		operator = r.Header.Get("X-Operator")
		raw, _ := io.ReadAll(r.Body)
		body = string(raw)
		_, _ = io.WriteString(w, `{"rig_id":"rig-1","granted":false,"workload_subject":"s"}`)
	})
	if _, err := c.PutGrant(context.Background(), "rig-1", false, "ops@shorted.com.au"); err != nil {
		t.Fatal(err)
	}
	if method != http.MethodPut || operator != "ops@shorted.com.au" {
		t.Fatalf("method %s operator %q", method, operator)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(body), &got); err != nil || len(got) != 1 || got["granted"] != false {
		t.Fatalf("body = %s", body)
	}
}

func TestEmptyOperatorSendsNoHeader(t *testing.T) {
	var present bool
	_, c := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, present = r.Header["X-Operator"]
		_, _ = io.WriteString(w, `{"rig_id":"rig-1","granted":true,"workload_subject":"s"}`)
	})
	if _, err := c.PutGrant(context.Background(), "rig-1", true, "  "); err != nil {
		t.Fatal(err)
	}
	if present {
		t.Fatal("an empty operator sent X-Operator")
	}
}

func TestStatusesMapToTypedOutcomes(t *testing.T) {
	cases := map[int]error{
		http.StatusNotFound:            ErrRigNotFound,
		http.StatusBadRequest:          ErrInvalidRequest,
		http.StatusUnauthorized:        ErrRejected,
		http.StatusForbidden:           ErrRejected,
		http.StatusInternalServerError: ErrUnavailable,
		http.StatusBadGateway:          ErrUnavailable,
		http.StatusTeapot:              ErrUnavailable,
	}
	for status, want := range cases {
		_, c := newServer(t, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(status)
			_, _ = io.WriteString(w, `{"detail":"`+testToken+` leaked?"}`)
		})
		_, err := c.PutGrant(context.Background(), "rig-1", true, "")
		if !errors.Is(err, want) {
			t.Errorf("status %d: err = %v, want %v", status, err, want)
		}
		if err != nil && strings.Contains(err.Error(), testToken) {
			t.Errorf("status %d: the token appears in the error: %v", status, err)
		}
	}
}

func TestATimeoutIsUnavailableNotAFailure(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { <-release }))
	t.Cleanup(func() { close(release); srv.Close() })
	c, err := NewTestClient(srv.URL, testToken, 50*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.PutGrant(context.Background(), "rig-1", true, "")
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable (unknown outcome)", err)
	}
}

func TestARedirectIsRefusedAndNeverFollowed(t *testing.T) {
	var hit bool
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hit = true }))
	t.Cleanup(target.Close)
	_, c := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+r.URL.Path, http.StatusTemporaryRedirect)
	})
	_, err := c.GetGrant(context.Background(), "rig-1")
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}
	if hit {
		t.Fatal("the redirect target was contacted: the token would have followed")
	}
}

func TestRigIDIsEscapedInThePath(t *testing.T) {
	var path string
	_, c := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.EscapedPath()
		_, _ = io.WriteString(w, `{"rig_id":"x","granted":false,"workload_subject":"s"}`)
	})
	if _, err := c.GetGrant(context.Background(), "a/../b"); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(path, "/../") {
		t.Fatalf("path %q lets a rig id escape the route", path)
	}
}

func TestFromEnvRefusesAnyHostOtherThanBrandBrain(t *testing.T) {
	tok := map[string]string{EnvGrantToken: testToken}
	env := func(extra map[string]string) func(string) string {
		return func(k string) string {
			if v, ok := extra[k]; ok {
				return v
			}
			return tok[k]
		}
	}
	bad := []string{
		"http://api.brandbrain.dev",
		"https://evil.example",
		"https://api.brandbrain.dev.evil.example",
		"https://api.brandbrain.dev:8443",
		"https://user@api.brandbrain.dev",
		"https://api.brandbrain.dev/path",
		"https://api.brandbrain.dev?x=1",
		"https://api.brandbrain.dev#frag",
		"not a url",
	}
	for _, u := range bad {
		c, err := FromEnv(env(map[string]string{EnvBaseURL: u}))
		if err == nil || c != nil {
			t.Errorf("FromEnv(%q) accepted: client=%v err=%v", u, c, err)
		}
	}
	for _, u := range []string{"", "https://api.brandbrain.dev", "https://api.brandbrain.dev/"} {
		c, err := FromEnv(env(map[string]string{EnvBaseURL: u}))
		if err != nil || c == nil {
			t.Errorf("FromEnv(%q) refused: %v", u, err)
		}
	}
}

func TestFromEnvWithoutTokenIsNotConfigured(t *testing.T) {
	c, err := FromEnv(func(string) string { return "" })
	if err != nil || c != nil {
		t.Fatalf("client=%v err=%v; want nil, nil", c, err)
	}
	var nilClient *Client
	if _, err := nilClient.GetGrant(context.Background(), "rig-1"); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("nil client err = %v", err)
	}
}

func TestNewTestClientRefusesNonLoopback(t *testing.T) {
	if _, err := NewTestClient("https://api.brandbrain.dev", testToken, 0); err == nil {
		t.Fatal("the test hook accepted a production host")
	}
}
