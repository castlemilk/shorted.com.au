package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
)

const (
	proxyAgentTokenSentinel = "sentinel-agent-token-5c1d"
	proxyPort               = "4411"
)

// setCycleChildMarkers makes the process look like a cycle child: the round-only events fd and
// the cycle id, both of which a cycle passes and a hand-run process does not have together.
func setCycleChildMarkers(t *testing.T) {
	t.Helper()
	var fds [2]int
	if err := syscall.Pipe(fds[:]); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = syscall.Close(fds[0]) })
	go func() { _, _ = io.Copy(io.Discard, os.NewFile(uintptr(fds[0]), "drain")) }()
	t.Setenv(crawlEventsFDEnv, strconv.Itoa(fds[1]))
	t.Setenv("CRAWL_CYCLE_ID", "cyc-proxy-test")
}

// proxyRecorder stands in for the loopback agent proxy. It answers every request with status,
// and records each request's method, path and headers so a test can see what the round sent.
type proxyRecorder struct {
	status int

	mu       sync.Mutex
	requests []recordedRequest
}

type recordedRequest struct {
	method, path, auth, control string
}

func (p *proxyRecorder) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	p.requests = append(p.requests, recordedRequest{
		method:  r.Method,
		path:    r.URL.Path,
		auth:    r.Header.Get("Authorization"),
		control: r.Header.Get(controlSecretHeader),
	})
	p.mu.Unlock()
	if p.status != 0 && p.status != http.StatusOK {
		w.WriteHeader(p.status)
		_, _ = w.Write([]byte(`{"code":"unauthenticated"}`))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{})
}

func (p *proxyRecorder) snapshot() []recordedRequest {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]recordedRequest(nil), p.requests...)
}

// proxyEnv is a cycle child's environment: the proxy, the per-cycle secret, the markers, and
// every credential a round must never see, all set so the test proves they are ignored.
func proxyEnv(t *testing.T, proxyURL string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	plantControlSecret(t, home, controlSentinel)
	t.Setenv("BRANDBRAIN_CONTROL_SECRET", controlSentinel)
	t.Setenv("BRANDBRAIN_AGENT_TOKEN", proxyAgentTokenSentinel)
	t.Setenv("BRANDBRAIN_AGENT_URL", "https://api.brandbrain.dev")
	t.Setenv("BRANDBRAIN_CONTROL_PORT", proxyPort)
	t.Setenv(agentProxyURLEnv, proxyURL)
	t.Setenv(workloadTokenSecretEnv, wtsSentinel)
	setCycleChildMarkers(t)
	t.Setenv(tokenSourceEnv, tokenSourceWorkload)
}

// A cycle child reaches the queue only through the proxy, with the per-cycle secret. It never
// reads the planted control secret, the env control secret, or the agent token, even though all
// three are set here.
func TestProxyRoundUsesOnlyTheProxyAndTheSecret(t *testing.T) {
	rec := &proxyRecorder{}
	srv := httptest.NewServer(rec)
	t.Cleanup(srv.Close)
	proxyURL := srv.URL + agentProxyPath
	proxyEnv(t, proxyURL)

	mode, refusal := resolveRoundTokenSource(os.Getenv)
	if refusal != "" || !mode {
		t.Fatalf("a cycle child must take the workload path: workload=%v refusal=%q", mode, refusal)
	}
	acfg := loadAgentConfig(mode)
	if acfg.controlSecret != "" {
		t.Fatal("the round read a control secret")
	}
	if acfg.brandbrainURL != proxyURL || !acfg.proxy || acfg.token != wtsSentinel {
		t.Fatalf("round queue is not the proxy with the per-cycle secret: url=%q proxy=%v", acfg.brandbrainURL, acfg.proxy)
	}

	c := newBrandbrainAgentClient(acfg)
	if c.canRefresh() {
		t.Fatal("a cycle round can refresh its token")
	}
	for _, call := range []func() error{
		func() error { return c.renew(context.Background(), "job-1") },
		func() error {
			return c.submit(context.Background(), "job-1", "done", nil, "", 0)
		},
	} {
		if err := call(); err != nil {
			t.Fatalf("queue call through the proxy: %v", err)
		}
	}
	reqs := rec.snapshot()
	if len(reqs) != 2 {
		t.Fatalf("proxy saw %d requests, want 2", len(reqs))
	}
	for _, r := range reqs {
		if r.auth != "Bearer "+wtsSentinel {
			t.Fatalf("a queue call did not carry the per-cycle secret as its bearer")
		}
		if r.control != "" {
			t.Fatal("the control secret header reached the proxy")
		}
		if strings.Contains(r.path, "session/export") {
			t.Fatal("a round exported a session")
		}
	}
	if reqs[0].path != "/control/v1/agent-proxy/api/v1/agent/crawl-jobs/renew" ||
		reqs[1].path != "/control/v1/agent-proxy/api/v1/agent/crawl-jobs/submit" {
		t.Fatalf("paths = %q, %q", reqs[0].path, reqs[1].path)
	}
}

// A 401 from the proxy is terminal: no refresh, no session export, one request only. The
// control API is fully configured on the client so that only the cycle guard stops a refresh.
func TestProxy401IsTerminalAndNeverRefreshes(t *testing.T) {
	rec := &proxyRecorder{status: http.StatusUnauthorized}
	srv := httptest.NewServer(rec)
	t.Cleanup(srv.Close)
	proxyEnv(t, srv.URL+agentProxyPath)

	acfg := loadAgentConfig(true)
	c := newBrandbrainAgentClient(acfg)
	c.controlURL = srv.URL // a refresh would call this control API
	c.controlSecret = controlSentinel

	if c.canRefresh() {
		t.Fatal("canRefresh is true for a cycle round with a configured control API")
	}
	err := c.renew(context.Background(), "job-1")
	if err == nil || !strings.Contains(err.Error(), "401 from the agent proxy") {
		t.Fatalf("err = %v, want a terminal proxy 401", err)
	}
	reqs := rec.snapshot()
	if len(reqs) != 1 {
		t.Fatalf("a 401 made %d requests; a refresh or a retry happened", len(reqs))
	}
	for _, r := range reqs {
		if strings.Contains(r.path, "session/export") || r.control != "" {
			t.Fatal("a 401 triggered a session export or sent the control secret")
		}
	}
	before := len(rec.snapshot())
	if _, err := c.refreshToken(context.Background()); err == nil {
		t.Fatal("refreshToken ran in a cycle round")
	}
	if len(rec.snapshot()) != before {
		t.Fatal("refreshToken contacted the control API in a cycle round")
	}
}

// The proxy URL is exactly the loopback proxy. Every variant below names another host, scheme,
// port, path, query or fragment, and each must be refused.
func TestProxyURLMustBeExactlyTheLoopbackProxy(t *testing.T) {
	if got, port := parseAgentProxyURL("http://127.0.0.1:" + proxyPort + agentProxyPath); got != "http://127.0.0.1:"+proxyPort+agentProxyPath || port != proxyPort {
		t.Fatalf("the exact loopback proxy URL was refused: %q", got)
	}
	bad := []string{
		"http://localhost:" + proxyPort + agentProxyPath,
		"http://127.0.0.2:" + proxyPort + agentProxyPath,
		"http://[::1]:" + proxyPort + agentProxyPath,
		"http://evil.example:" + proxyPort + agentProxyPath,
		"https://127.0.0.1:" + proxyPort + agentProxyPath,
		"http://127.0.0.1:" + proxyPort + agentProxyPath + "/",
		"http://127.0.0.1:" + proxyPort + agentProxyPath + "?x=1",
		"http://127.0.0.1:" + proxyPort + agentProxyPath + "#frag",
		"http://127.0.0.1:" + proxyPort + agentProxyPath + "/../workload-token",
		"http://user@127.0.0.1:" + proxyPort + agentProxyPath,
		"http://127.0.0.1" + agentProxyPath,
		"http://127.0.0.1:0" + agentProxyPath,
		"http://127.0.0.1:65536" + agentProxyPath,
		"http://127.0.0.1:04411" + agentProxyPath,
		"http://127.0.0.1:" + proxyPort + "/control/v1/workload-token",
		"http://127.0.0.1:" + proxyPort + "/control/v1/agent-proxy-evil",
		"",
	}
	for _, raw := range bad {
		if got, _ := parseAgentProxyURL(raw); got != "" {
			t.Fatalf("parseAgentProxyURL(%q) accepted a non-loopback or non-exact URL: %q", raw, got)
		}
	}
}

// A non-loopback or malformed proxy URL refuses the round before any request, exit 8, and the
// refusal names the variable, not the value.
func TestProxyRoundRefusesANonLoopbackURL(t *testing.T) {
	rec := &proxyRecorder{}
	srv := httptest.NewServer(rec)
	t.Cleanup(srv.Close)
	proxyEnv(t, "http://evil.example:"+proxyPort+agentProxyPath)

	var logBuf lockedBuf
	prev := log.Writer()
	log.SetOutput(&logBuf)
	t.Cleanup(func() { log.SetOutput(prev) })

	if got := runAgent(context.Background(), nil); got != exitSinkRefused {
		t.Fatalf("exit = %d, want %d", got, exitSinkRefused)
	}
	if !strings.Contains(logBuf.String(), agentProxyURLEnv) {
		t.Fatalf("the refusal does not name %s", agentProxyURLEnv)
	}
	if strings.Contains(logBuf.String(), "evil.example") {
		t.Fatal("the refusal echoed the rejected URL")
	}
	if len(rec.snapshot()) != 0 {
		t.Fatal("a refused round made a request")
	}
}

// CRAWL_TOKEN_SOURCE is honoured only in a cycle child. Hand-set on a plain -mode agent run, or
// with only one of the cycle's markers, it is refused, and the legacy path is not taken.
func TestHandSetTokenSourceIsRefusedOutsideACycle(t *testing.T) {
	t.Setenv(tokenSourceEnv, tokenSourceWorkload)
	t.Setenv("CRAWL_CYCLE_ID", "")
	t.Setenv(crawlEventsFDEnv, "")
	if mode, refusal := resolveRoundTokenSource(os.Getenv); mode || refusal == "" {
		t.Fatalf("a hand-set workload source on a plain run was honoured: mode=%v", mode)
	}

	t.Setenv("CRAWL_CYCLE_ID", "cyc-only-id")
	if mode, refusal := resolveRoundTokenSource(os.Getenv); mode || refusal == "" {
		t.Fatal("a cycle id without the events fd was honoured")
	}

	t.Setenv(crawlEventsFDEnv, "not-an-fd")
	if mode, refusal := resolveRoundTokenSource(os.Getenv); mode || refusal == "" {
		t.Fatal("a non-numeric events fd was honoured")
	}

	t.Setenv(tokenSourceEnv, "control")
	if _, refusal := resolveRoundTokenSource(os.Getenv); refusal == "" {
		t.Fatal("an unknown token source was accepted")
	}

	// And the whole run refuses, with the variable named, before any request.
	t.Setenv(tokenSourceEnv, tokenSourceWorkload)
	t.Setenv(crawlEventsFDEnv, "")
	var logBuf lockedBuf
	prev := log.Writer()
	log.SetOutput(&logBuf)
	t.Cleanup(func() { log.SetOutput(prev) })
	if got := runAgent(context.Background(), nil); got != exitSinkRefused {
		t.Fatalf("exit = %d, want %d", got, exitSinkRefused)
	}
	if !strings.Contains(logBuf.String(), tokenSourceEnv) {
		t.Fatal("the refusal does not name CRAWL_TOKEN_SOURCE")
	}
}

// The legacy path is unchanged: with no token source it reads the agent token and the control
// secret exactly as before.
func TestLegacyAgentModeIsUnchanged(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv(tokenSourceEnv, "")
	t.Setenv("BRANDBRAIN_AGENT_URL", "https://api.brandbrain.dev")
	t.Setenv("BRANDBRAIN_AGENT_TOKEN", proxyAgentTokenSentinel)
	acfg := loadAgentConfig(false)
	if acfg.workloadTokens || acfg.proxy {
		t.Fatal("the legacy path took the cycle branch")
	}
	if acfg.brandbrainURL != "https://api.brandbrain.dev" || acfg.token != proxyAgentTokenSentinel {
		t.Fatal("the legacy config changed")
	}
}

// The proxy secret never reaches the log, an event, or a request error, on any path the round
// takes, including the refusal and the 401.
func TestProxySecretNeverAppearsInEventsOrLogs(t *testing.T) {
	rec := &proxyRecorder{status: http.StatusUnauthorized}
	srv := httptest.NewServer(rec)
	t.Cleanup(srv.Close)
	proxyEnv(t, srv.URL+agentProxyPath)

	var logBuf lockedBuf
	prev := log.Writer()
	log.SetOutput(&logBuf)
	t.Cleanup(func() { log.SetOutput(prev) })

	c := newBrandbrainAgentClient(loadAgentConfig(true))
	err := c.renew(context.Background(), "job-1")
	if err == nil {
		t.Fatal("a 401 was accepted")
	}
	assertNoSecret(t, "the error", err.Error(), wtsSentinel, controlSentinel, proxyAgentTokenSentinel)
	assertNoSecret(t, "log", logBuf.String(), wtsSentinel, controlSentinel, proxyAgentTokenSentinel)
}

// A round receives the proxy URL and the per-cycle secret from its cycle, and no other
// BrandBrain credential or direct URL, even when every one of them is in the cycle's env.
func TestCycleChildEnvHandsARoundOnlyTheProxyAndTheSecret(t *testing.T) {
	t.Setenv("BRANDBRAIN_AGENT_TOKEN", proxyAgentTokenSentinel)
	t.Setenv("BRANDBRAIN_AGENT_URL", "https://api.brandbrain.dev")
	t.Setenv(controlSecretEnv, controlSentinel)
	t.Setenv(workloadTokenSecretEnv, wtsSentinel)
	r := &cycleRunner{cfg: cycleConfig{cycleID: "cyc-env", workloadSecret: wtsSentinel, proxyURL: "http://127.0.0.1:" + proxyPort + agentProxyPath}}
	env := r.childEnv()
	for _, banned := range []string{agentTokenEnv + "=", agentURLEnv + "=", controlSecretEnv + "="} {
		for _, kv := range env {
			if strings.HasPrefix(kv, banned) {
				t.Fatalf("a round received %s", strings.TrimSuffix(banned, "="))
			}
		}
	}
	if !containsEnv(env, agentProxyURLEnv+"=http://127.0.0.1:"+proxyPort+agentProxyPath) {
		t.Fatal("the round did not receive the proxy URL")
	}
	assertNoSecret(t, "child env", strings.Join(env, "\n"), proxyAgentTokenSentinel, controlSentinel)
}
