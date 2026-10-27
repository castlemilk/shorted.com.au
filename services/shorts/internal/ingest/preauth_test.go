package ingest

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// countingBody counts the bytes a handler reads from a request body.
type countingBody struct {
	io.ReadCloser
	n int64
}

func (c *countingBody) Read(p []byte) (int, error) {
	n, err := c.ReadCloser.Read(p)
	c.n += int64(n)
	return n, err
}

// gzipBody is a body over the 4 MiB cap once decoded: random bytes, so they do not
// compress, and a gzip body of roughly the same size on the wire.
func gzipBody(t *testing.T, n int) []byte {
	t.Helper()
	raw := make([]byte, n)
	if _, err := rand.Read(raw); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	if _, err := gz.Write(raw); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// TestPreAuth_UnauthenticatedGzipBodyIsNeverRead is the review's test. The ingest is
// publicly invokable on Cloud Run, so a caller without a credential must not make the
// service read or decompress a body. The counting reader sits outside the ingest
// handler, so every byte the handler reads is counted. The request must be refused with
// 401 and the count must be zero: not a byte beyond the headers.
func TestPreAuth_UnauthenticatedGzipBodyIsNeverRead(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	svc := New(context.Background(), Options{
		Config:     testConfigFor(issuer),
		Pool:       pool,
		Now:        clock.Now,
		HTTPClient: issuer.client,
	})
	path, handler := svc.Handler()

	var counted *countingBody
	mux := http.NewServeMux()
	mux.Handle(path, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		counted = &countingBody{ReadCloser: r.Body}
		r.Body = counted
		handler.ServeHTTP(w, r)
	}))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	waitVerifier(t, svc)
	body := gzipBody(t, 5<<20)
	req, err := http.NewRequest(http.MethodPost, srv.URL+path+"PushSweep", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/proto")
	req.Header.Set("Connect-Protocol-Version", "1")
	req.Header.Set("Content-Encoding", "gzip")
	// No Authorization header: the caller has not proved who they are.

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	// The byte count is checked first, so a read is reported as a read even when the
	// refusal status would otherwise have failed the test for another reason.
	if counted == nil {
		t.Fatal("the counting reader was never installed, so the check proves nothing")
	}
	if counted.n != 0 {
		t.Errorf("the service read %d body byte(s) before authenticating; it must read none", counted.n)
	}
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("an unauthenticated call must be 401, got %d", resp.StatusCode)
	}
	var out map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("the refusal must be a Connect error body: %v", err)
	}
	if out["code"] != "unauthenticated" {
		t.Errorf("the Connect code must be unauthenticated, got %q", out["code"])
	}
}

// TestPreAuth_BadTokenBodyIsNeverRead: the same guarantee for a credential that does not
// verify. A forged token is refused before the body is read.
func TestPreAuth_BadTokenBodyIsNeverRead(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	svc := New(context.Background(), Options{
		Config:     testConfigFor(issuer),
		Pool:       pool,
		Now:        clock.Now,
		HTTPClient: issuer.client,
	})
	path, handler := svc.Handler()
	var counted *countingBody
	mux := http.NewServeMux()
	mux.Handle(path, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		counted = &countingBody{ReadCloser: r.Body}
		r.Body = counted
		handler.ServeHTTP(w, r)
	}))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	waitVerifier(t, svc)
	forged := signedWithOtherKey(t, issuer, testRig, clock.Now())
	req, err := http.NewRequest(http.MethodPost, srv.URL+path+"PushSweep", bytes.NewReader(gzipBody(t, 5<<20)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/proto")
	req.Header.Set("Connect-Protocol-Version", "1")
	req.Header.Set("Content-Encoding", "gzip")
	req.Header.Set("Authorization", "Bearer "+forged)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if counted == nil || counted.n != 0 {
		t.Errorf("a forged token must not cause a body read, read %d", bytesRead(counted))
	}
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("a forged token must be 401, got %d", resp.StatusCode)
	}
}

// TestPreAuth_IssuerOutageIsUnavailableWithoutBodyRead: an issuer outage with no cached
// keys is 503 with jwks_unavailable, and the body is not read.
func TestPreAuth_IssuerOutageIsUnavailableWithoutBodyRead(t *testing.T) {
	pool := ingestTestDB(t)
	issuer := newIssuerFixture(t)
	clock := newTestClock()
	issuer.setDown(true)
	svc := New(context.Background(), Options{
		Config:     testConfigFor(issuer),
		Pool:       pool,
		Now:        clock.Now,
		HTTPClient: issuer.client,
	})
	path, handler := svc.Handler()
	var counted *countingBody
	mux := http.NewServeMux()
	mux.Handle(path, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		counted = &countingBody{ReadCloser: r.Body}
		r.Body = counted
		handler.ServeHTTP(w, r)
	}))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	token := issuer.mint(t, testRig, clock.Now(), nil)
	req, err := http.NewRequest(http.MethodPost, srv.URL+path+"PushSweep", bytes.NewReader(gzipBody(t, 5<<20)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/proto")
	req.Header.Set("Connect-Protocol-Version", "1")
	req.Header.Set("Content-Encoding", "gzip")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if counted == nil || counted.n != 0 {
		t.Errorf("an outage must not cause a body read, read %d", bytesRead(counted))
	}
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("an issuer outage must be 503, got %d", resp.StatusCode)
	}
	var out map[string]string
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if out["code"] != "unavailable" || !strings.Contains(out["message"], "jwks_unavailable") {
		t.Errorf("want unavailable with jwks_unavailable, got %v", out)
	}
}

// waitVerifier blocks until the service's verifier has its keys, so a test that
// exercises signature checks starts from a loaded cache.
func waitVerifier(t *testing.T, svc *Service) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := svc.wa.Ready(ctx); err != nil {
		t.Fatalf("verifier never loaded keys: %v", err)
	}
}

func bytesRead(c *countingBody) int64 {
	if c == nil {
		return -1
	}
	return c.n
}

// testConfigFor is the configuration the pre-auth tests use: enabled, with the issuer's
// audience and org, and the two test rigs allowlisted.
func testConfigFor(issuer *issuerFixture) Config {
	return Config{
		Enabled:            true,
		Issuer:             issuer.issuer,
		Audience:           testAudience,
		Org:                testIssuerOrg,
		AllowSubjects:      []string{testRig, testRig2},
		MinContractVersion: DefaultMinContractVersion,
		PriceFraction:      DefaultPriceFraction,
		QuarantineMinMoves: DefaultQuarantineMinMoves,
		DelistFraction:     DefaultDelistFraction,
		DelistCap:          DefaultDelistCap,
		MinDelists:         DefaultMinDelists,
		DispatchTTL:        DefaultDispatchTTL,
		DBMaxConns:         DefaultDBMaxConns,
	}
}
