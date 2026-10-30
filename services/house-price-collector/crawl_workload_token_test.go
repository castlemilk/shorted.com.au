package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	connectrpc "connectrpc.com/connect"
)

// Sentinels. None of these may appear in an event, stdout, stderr, a log line or a request
// header that the wrong credential would have been sent in.
const (
	wtsSentinel         = "sentinel-wts-7f3a"
	controlSentinel     = "sentinel-control-9b2e"
	mintedWorkloadToken = "eyJhbGciOi.c3R1Yg.sig1"
)

// loopbackRecorder stands in for the co-located agent's loopback control API. It mints a
// workload token only for the bearer workloadSecret and records the credential headers every
// request carried, so a test can see which secret was sent and on which path.
type loopbackRecorder struct {
	workloadSecret string

	mu             sync.Mutex
	hits           int
	authHeaders    []string
	controlHeaders []string
}

func (l *loopbackRecorder) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.hits++
	if v := r.Header.Get("Authorization"); v != "" {
		l.authHeaders = append(l.authHeaders, v)
	}
	if v := r.Header.Get(controlSecretHeader); v != "" {
		l.controlHeaders = append(l.controlHeaders, v)
	}
	if r.URL.Path != workloadTokenPath || r.URL.Query().Get("audience") != ingestAudience {
		http.NotFound(w, r)
		return
	}
	if r.Header.Get("Authorization") != "Bearer "+l.workloadSecret {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"token":      mintedWorkloadToken,
		"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
		"audience":   ingestAudience,
	})
}

func (l *loopbackRecorder) snapshot() (hits int, auth, control []string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.hits, append([]string(nil), l.authHeaders...), append([]string(nil), l.controlHeaders...)
}

// controlSecretHeader is the legacy control-secret header name, spelled once here.
const controlSecretHeader = "X-Agent-Control-Secret"

// plantControlSecret writes a control_secret file under home, the file the legacy path reads.
func plantControlSecret(t *testing.T, home, secret string) {
	t.Helper()
	dir := filepath.Join(home, ".brandbrain")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "control_secret"), []byte(secret+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

// useLoopbackIngest lets validateIngestURL accept an httptest ingest server for one test.
func useLoopbackIngest(t *testing.T) {
	t.Helper()
	prev := testAllowLoopbackIngest
	testAllowLoopbackIngest = true
	t.Cleanup(func() { testAllowLoopbackIngest = prev })
}

// assertNoSecret fails if any sentinel appears in the named capture.
func assertNoSecret(t *testing.T, where, text string, sentinels ...string) {
	t.Helper()
	for _, s := range sentinels {
		if strings.Contains(text, s) {
			t.Fatalf("%s carries a secret value (%s)", where, s)
		}
	}
}

// cycleWorkloadEnv is the env a cycle runs with: the ingest sink, a pinned loopback ingest,
// and the loopback control port. The caller adds the secrets under test.
func cycleWorkloadEnv(ingestURL, controlPort string) map[string]string {
	return map[string]string{
		"CRAWL_SINK":              "ingest",
		"SHORTED_INGEST_URL":      ingestURL,
		"CRAWL_DRY_RUN":           "true",
		"BRANDBRAIN_CONTROL_PORT": controlPort,
		"BRANDBRAIN_AGENT_URL":    "",
		"DATABASE_URL":            "",
		agentProxyURLEnv:          "http://127.0.0.1:" + controlPort + agentProxyPath,
	}
}

func TestCycleMintsWithTheWorkloadSecretAndNeverReadsTheControlSecret(t *testing.T) {
	useLoopbackIngest(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	plantControlSecret(t, home, controlSentinel)
	// The control secret is in the process env too, so the test proves it is ignored, not absent.
	t.Setenv("BRANDBRAIN_CONTROL_SECRET", controlSentinel)

	lb := &loopbackRecorder{workloadSecret: wtsSentinel}
	lbSrv := httptest.NewServer(lb)
	t.Cleanup(lbSrv.Close)

	var ingestBearers []string
	var bearerMu sync.Mutex
	fi := &stubIngest{
		log: &stubCallLog{},
		authErr: func(bearer string) error {
			bearerMu.Lock()
			ingestBearers = append(ingestBearers, bearer)
			bearerMu.Unlock()
			if bearer != mintedWorkloadToken {
				return connectrpc.NewError(connectrpc.CodeUnauthenticated, errors.New("unauthenticated"))
			}
			return nil
		},
	}
	ingestSrv := serveStubIngest(t, fi)

	env := cycleWorkloadEnv(ingestSrv.URL, stubURLPort(t, lbSrv.URL))
	env["BRANDBRAIN_WORKLOAD_TOKEN_SECRET"] = wtsSentinel
	env["BRANDBRAIN_CONTROL_SECRET"] = controlSentinel
	getenv := func(k string) string { return env[k] }

	var stdout, evbuf, logBuf lockedBuf
	prevLog := log.Writer()
	log.SetOutput(&logBuf)
	t.Cleanup(func() { log.SetOutput(prevLog) })

	isolateCrawlFetchEnv(t)
	code := runCycleMode(&stdout, cycleJobPreflight, false, time.Hour, getenv, newCrawlEvents(&evbuf))
	if code != 0 {
		t.Fatalf("preflight exit = %d, want 0 (its checks ran)", code)
	}

	hits, auth, control := lb.snapshot()
	if hits == 0 {
		t.Fatal("the loopback mint was never called")
	}
	if len(control) != 0 {
		t.Fatalf("the control secret header was sent on the cycle path %d times", len(control))
	}
	for _, a := range auth {
		if a != "Bearer "+wtsSentinel {
			t.Fatalf("a mint carried a credential other than the workload secret")
		}
	}
	bearerMu.Lock()
	got := append([]string(nil), ingestBearers...)
	bearerMu.Unlock()
	authenticated := false
	for _, b := range got {
		if b == mintedWorkloadToken {
			authenticated = true
		}
	}
	if !authenticated {
		t.Fatalf("ingest never saw the minted workload token; bearers=%d", len(got))
	}

	assertNoSecret(t, "stdout", stdout.String(), wtsSentinel, controlSentinel)
	assertNoSecret(t, "events", evbuf.String(), wtsSentinel, controlSentinel)
	assertNoSecret(t, "log", logBuf.String(), wtsSentinel, controlSentinel)
}

func TestCycleWithoutTheWorkloadSecretRefusesExit8AndNamesTheVariable(t *testing.T) {
	useLoopbackIngest(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	plantControlSecret(t, home, controlSentinel)
	t.Setenv("BRANDBRAIN_CONTROL_SECRET", controlSentinel)

	lb := &loopbackRecorder{workloadSecret: wtsSentinel}
	lbSrv := httptest.NewServer(lb)
	t.Cleanup(lbSrv.Close)
	ingestSrv := serveStubIngest(t, &stubIngest{log: &stubCallLog{}})

	// The control secret is present in the env and in the file. The cycle must still refuse.
	env := cycleWorkloadEnv(ingestSrv.URL, stubURLPort(t, lbSrv.URL))
	env["BRANDBRAIN_CONTROL_SECRET"] = controlSentinel
	getenv := func(k string) string { return env[k] }

	var stdout, evbuf, logBuf lockedBuf
	prevLog := log.Writer()
	log.SetOutput(&logBuf)
	t.Cleanup(func() { log.SetOutput(prevLog) })

	isolateCrawlFetchEnv(t)
	code := runCycleMode(&stdout, cycleJobDrain, false, time.Hour, getenv, newCrawlEvents(&evbuf))
	if code != exitSinkRefused {
		t.Fatalf("exit = %d, want %d", code, exitSinkRefused)
	}
	if hits, _, _ := lb.snapshot(); hits != 0 {
		t.Fatalf("a refused cycle still called the loopback %d times", hits)
	}

	lines := strings.Split(strings.TrimRight(stdout.String(), "\n"), "\n")
	if len(lines) != 1 {
		t.Fatalf("a refused cycle prints one summary line, got %d", len(lines))
	}
	var s cycleSummary
	if err := json.Unmarshal([]byte(lines[0]), &s); err != nil {
		t.Fatal(err)
	}
	if s.Outcome != outPreflightFailed || s.ExitCode != exitSinkRefused {
		t.Fatalf("summary outcome=%q exit=%d, want preflight_failed and 8", s.Outcome, s.ExitCode)
	}

	// The refusal reason names the variable, and it is the only thing that does.
	if !strings.Contains(logBuf.String(), workloadTokenSecretEnv) {
		t.Fatalf("the refusal does not name %s: %q", workloadTokenSecretEnv, logBuf.String())
	}
	assertNoSecret(t, "stdout", stdout.String(), controlSentinel, wtsSentinel)
	assertNoSecret(t, "events", evbuf.String(), controlSentinel, wtsSentinel)
	assertNoSecret(t, "log", logBuf.String(), controlSentinel, wtsSentinel)
}

func TestCycleLoaderReadsOnlyThePortAndTheWorkloadSecret(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	plantControlSecret(t, home, controlSentinel)
	env := map[string]string{
		"BRANDBRAIN_CONTROL_PORT":          "4411",
		"BRANDBRAIN_CONTROL_SECRET":        controlSentinel,
		"BRANDBRAIN_AGENT_TOKEN":           "sentinel-agent-token-5c1d",
		agentProxyURLEnv:                   "http://127.0.0.1:4411" + agentProxyPath,
		"BRANDBRAIN_WORKLOAD_TOKEN_SECRET": wtsSentinel,
	}
	acfg := loadCycleAgentConfig(func(k string) string { return env[k] })
	if acfg.controlSecret != "" {
		t.Fatal("the cycle loader filled controlSecret: the control secret is read on the cycle path")
	}
	if !acfg.workloadTokens || acfg.workloadSecret != wtsSentinel {
		t.Fatalf("workloadTokens=%v secret set=%v, want the workload secret", acfg.workloadTokens, acfg.workloadSecret != "")
	}
	if acfg.controlURL != "http://127.0.0.1:4411" {
		t.Fatalf("controlURL = %q", acfg.controlURL)
	}
	if acfg.brandbrainURL != "http://127.0.0.1:4411"+agentProxyPath || !acfg.proxy || acfg.token != wtsSentinel {
		t.Fatalf("queue is not the proxy with the per-cycle secret: url=%q proxy=%v token-is-secret=%v", acfg.brandbrainURL, acfg.proxy, acfg.token == wtsSentinel)
	}
}

func TestCycleChildEnvCarriesTheWorkloadSecretOnlyToTheRound(t *testing.T) {
	// The cycle process itself has no secret in its environment (scrubbed at entry), and the
	// control secret must never reach a child, so both are set here to prove the builder drops them.
	t.Setenv("BRANDBRAIN_CONTROL_SECRET", controlSentinel)
	t.Setenv("BRANDBRAIN_WORKLOAD_TOKEN_SECRET", wtsSentinel)

	withSecret := &cycleRunner{cfg: cycleConfig{cycleID: "cyc-env", workloadSecret: wtsSentinel}}
	env := withSecret.childEnv()
	n := 0
	for _, kv := range env {
		if strings.HasPrefix(kv, controlSecretEnv+"=") {
			t.Fatal("the control secret reached a child round")
		}
		if kv == workloadTokenSecretEnv+"="+wtsSentinel {
			n++
		}
		if strings.HasPrefix(kv, workloadTokenSecretEnv+"=") && kv != workloadTokenSecretEnv+"="+wtsSentinel {
			t.Fatal("the round received a workload secret other than the cycle's")
		}
	}
	if n != 1 {
		t.Fatalf("the round env carries the workload secret %d times, want once", n)
	}
	if !containsEnv(env, tokenSourceEnv+"="+tokenSourceWorkload) {
		t.Fatal("the round is not told to mint with the workload secret")
	}

	// A cycle with no workload secret must not pass one on, even when the process env has it.
	noSecret := &cycleRunner{cfg: cycleConfig{cycleID: "cyc-env"}}
	for _, kv := range noSecret.childEnv() {
		if strings.HasPrefix(kv, workloadTokenSecretEnv+"=") {
			t.Fatal("a cycle with no workload secret handed one to its child (inherited from the process env)")
		}
	}
}

func containsEnv(env []string, want string) bool {
	for _, kv := range env {
		if kv == want {
			return true
		}
	}
	return false
}

func TestWorkloadSecretIsScrubbedBeforeAnyOtherProcessStarts(t *testing.T) {
	t.Setenv(workloadTokenSecretEnv, wtsSentinel)
	scrubWorkloadSecret()
	if _, ok := os.LookupEnv(workloadTokenSecretEnv); ok {
		t.Fatal("the workload secret is still in this process's environment")
	}
	// A process started now, with no Env set, inherits the environment: it must not see the secret.
	envBin, err := exec.LookPath("env")
	if err != nil {
		t.Skipf("no env binary: %v", err)
	}
	out, err := exec.Command(envBin).Output()
	if err != nil {
		t.Fatal(err)
	}
	assertNoSecret(t, "a child process environment", string(out), wtsSentinel)
	if strings.Contains(string(out), workloadTokenSecretEnv+"=") {
		t.Fatal("a child process inherited the workload secret variable")
	}
}

func TestRoundWithWorkloadTokensMintsOnlyWithTheWorkloadSecret(t *testing.T) {
	lb := &loopbackRecorder{workloadSecret: wtsSentinel}
	lbSrv := httptest.NewServer(lb)
	t.Cleanup(lbSrv.Close)

	acfg := agentConfig{controlURL: lbSrv.URL, workloadTokens: true, workloadSecret: wtsSentinel}
	ir := newIngestRound(crawlSinkIngest, acfg, "http://127.0.0.1:1", nil)
	tok, err := ir.client.tokens.Token(context.Background(), false)
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	if tok != mintedWorkloadToken {
		t.Fatal("the round did not use the minted token")
	}
	_, auth, control := lb.snapshot()
	if len(control) != 0 || len(auth) != 1 || auth[0] != "Bearer "+wtsSentinel {
		t.Fatalf("mint headers auth=%d control=%d", len(auth), len(control))
	}

	// With no workload secret the round refuses to mint and never falls back to the control path.
	noSecret := newIngestRound(crawlSinkIngest, agentConfig{controlURL: lbSrv.URL, controlSecret: controlSentinel, workloadTokens: true}, "http://127.0.0.1:1", nil)
	if _, err := noSecret.client.tokens.Token(context.Background(), false); err == nil {
		t.Fatal("a round with no workload secret minted a token")
	}
	hits, _, control := lb.snapshot()
	if len(control) != 0 {
		t.Fatal("a round with no workload secret sent the control secret")
	}
	if hits != 1 {
		t.Fatalf("loopback hits = %d, want 1: the refused round must not make a request", hits)
	}
}

func TestRunAgentRefusesAWorkloadRoundWithoutTheWorkloadSecret(t *testing.T) {
	useLoopbackIngest(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	plantControlSecret(t, home, controlSentinel)
	ingestSrv := serveStubIngest(t, &stubIngest{log: &stubCallLog{}})
	ctlSrv := httptest.NewServer(&loopbackRecorder{workloadSecret: wtsSentinel})
	t.Cleanup(ctlSrv.Close)

	t.Setenv("CRAWL_SINK", "ingest")
	t.Setenv("CRAWL_DRY_RUN", "false")
	t.Setenv("SHORTED_INGEST_URL", ingestSrv.URL)
	t.Setenv("DATABASE_URL", "")
	t.Setenv("BRANDBRAIN_AGENT_URL", "http://127.0.0.1:1")
	t.Setenv("BRANDBRAIN_AGENT_TOKEN", "")
	t.Setenv("BRANDBRAIN_CONTROL_PORT", stubURLPort(t, ctlSrv.URL))
	t.Setenv("BRANDBRAIN_CONTROL_SECRET", controlSentinel)
	t.Setenv(agentProxyURLEnv, "http://127.0.0.1:"+stubURLPort(t, ctlSrv.URL)+agentProxyPath)
	setCycleChildMarkers(t)
	t.Setenv(tokenSourceEnv, tokenSourceWorkload)
	t.Setenv(workloadTokenSecretEnv, "")
	if err := os.Unsetenv(workloadTokenSecretEnv); err != nil {
		t.Fatal(err)
	}

	var logBuf lockedBuf
	prevLog := log.Writer()
	log.SetOutput(&logBuf)
	t.Cleanup(func() { log.SetOutput(prevLog) })

	isolateCircuitState(t)
	if got := runAgent(context.Background(), nil); got != exitSinkRefused {
		t.Fatalf("exit = %d, want %d", got, exitSinkRefused)
	}
	if !strings.Contains(logBuf.String(), workloadTokenSecretEnv) {
		t.Fatalf("the refusal does not name %s", workloadTokenSecretEnv)
	}
	assertNoSecret(t, "log", logBuf.String(), controlSentinel)
}
