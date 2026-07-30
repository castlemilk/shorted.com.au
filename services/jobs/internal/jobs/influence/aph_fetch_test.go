package influence

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newTestSink(t *testing.T) DocumentSink {
	t.Helper()
	sink, err := newLocalSink(t.TempDir())
	if err != nil {
		t.Fatalf("newLocalSink: %v", err)
	}
	return sink
}

// minimalPDF is a byte string that starts with the magic header, which is all
// the fetcher inspects. Parsing happens in the Python tier.
func minimalPDF(body string) []byte {
	return []byte("%PDF-1.6\n" + body + "\n%%EOF\n")
}

func TestFetchRegisterDocumentStoresAndHashes(t *testing.T) {
	payload := minimalPDF("register")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/pdf")
		_, _ = w.Write(payload)
	}))
	defer srv.Close()

	sink := newTestSink(t)
	res, err := fetchRegisterDocument(t.Context(), srv.Client(), PendingDocument{SourceURL: srv.URL}, sink)
	if err != nil {
		t.Fatalf("fetchRegisterDocument: %v", err)
	}

	want := sha256.Sum256(payload)
	if res.SHA256 != hex.EncodeToString(want[:]) {
		t.Errorf("SHA256 = %s, want %s", res.SHA256, hex.EncodeToString(want[:]))
	}
	if res.ByteSize != int64(len(payload)) {
		t.Errorf("ByteSize = %d, want %d", res.ByteSize, len(payload))
	}
	if res.Deduped {
		t.Error("first fetch must not be marked deduped")
	}
	if !strings.HasPrefix(res.StorageURI, "file://") {
		t.Errorf("StorageURI = %q", res.StorageURI)
	}

	stored, err := os.ReadFile(strings.TrimPrefix(res.StorageURI, "file://"))
	if err != nil {
		t.Fatalf("read stored object: %v", err)
	}
	if string(stored) != string(payload) {
		t.Error("stored bytes differ from the served bytes")
	}
}

// Content-addressing is what makes re-extraction free and makes "did APH change
// this document?" a byte comparison. A second fetch of identical bytes must not
// re-upload.
func TestFetchRegisterDocumentDedupesByContent(t *testing.T) {
	payload := minimalPDF("same")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(payload)
	}))
	defer srv.Close()

	sink := newTestSink(t)
	first, err := fetchRegisterDocument(t.Context(), srv.Client(), PendingDocument{SourceURL: srv.URL}, sink)
	if err != nil {
		t.Fatalf("first fetch: %v", err)
	}
	second, err := fetchRegisterDocument(t.Context(), srv.Client(), PendingDocument{SourceURL: srv.URL}, sink)
	if err != nil {
		t.Fatalf("second fetch: %v", err)
	}

	if !second.Deduped {
		t.Error("second fetch of identical bytes must be deduped")
	}
	if second.SHA256 != first.SHA256 || second.StorageURI != first.StorageURI {
		t.Errorf("dedup changed identity: %+v vs %+v", second, first)
	}
}

// An HTML interstitial served with HTTP 200 is exactly how a corpus of
// zero-value "PDFs" gets built silently.
func TestFetchRegisterDocumentRejectsNonPDFBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<html><head><title>WAF Block Page</title></head><body>blocked</body></html>"))
	}))
	defer srv.Close()

	sink := newTestSink(t)
	_, err := fetchRegisterDocument(t.Context(), srv.Client(), PendingDocument{SourceURL: srv.URL}, sink)
	if err == nil {
		t.Fatal("an HTML body served with HTTP 200 must not be accepted as a PDF")
	}
	if !strings.Contains(err.Error(), "not a PDF") {
		t.Errorf("error = %v, want a not-a-PDF diagnosis", err)
	}

	entries, _ := os.ReadDir(sinkDir(t, sink))
	for _, e := range entries {
		if filepath.Ext(e.Name()) == ".pdf" {
			t.Errorf("a rejected body was still stored: %s", e.Name())
		}
	}
}

func TestFetchRegisterDocumentRejectsEmptyBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	if _, err := fetchRegisterDocument(t.Context(), srv.Client(), PendingDocument{SourceURL: srv.URL}, newTestSink(t)); err == nil {
		t.Fatal("an empty 200 body must be rejected")
	}
}

// A 403 means the WAF changed its mind about us. It must be terminal and
// distinguishable, never retried around.
func TestFetchRegisterDocumentTreats403AsTerminalBlock(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte("<html>Page Blocked by WAF</html>"))
	}))
	defer srv.Close()

	_, err := fetchWithRetry(t.Context(), srv.Client(), PendingDocument{SourceURL: srv.URL}, newTestSink(t), 3)
	if err == nil {
		t.Fatal("a 403 must surface as an error")
	}
	if _, ok := errors.AsType[*errBlocked](err); !ok {
		t.Errorf("error type = %T, want *errBlocked so the caller can record 'blocked'", err)
	}
	if hits != 1 {
		t.Errorf("server saw %d requests; a 403 must never be retried", hits)
	}
}

// 5xx and 429 are ordinary flakiness and SHOULD be retried.
func TestFetchWithRetryRetriesServerErrors(t *testing.T) {
	// Keep the test fast: the production backoff starts at 5s.
	restore := registerRetryBackoff
	registerRetryBackoff = []time.Duration{time.Millisecond}
	t.Cleanup(func() { registerRetryBackoff = restore })

	payload := minimalPDF("eventually")
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		if hits < 3 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		_, _ = w.Write(payload)
	}))
	defer srv.Close()

	res, err := fetchWithRetry(t.Context(), srv.Client(), PendingDocument{SourceURL: srv.URL}, newTestSink(t), 3)
	if err != nil {
		t.Fatalf("fetchWithRetry: %v (hits=%d)", err, hits)
	}
	if hits != 3 {
		t.Errorf("server saw %d requests, want 3 (two 502s then success)", hits)
	}
	if res.SHA256 == "" {
		t.Error("successful retry produced no hash")
	}
}

func TestFetchWithRetryGivesUpAfterMaxAttempts(t *testing.T) {
	restore := registerRetryBackoff
	registerRetryBackoff = []time.Duration{time.Millisecond}
	t.Cleanup(func() { registerRetryBackoff = restore })

	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	if _, err := fetchWithRetry(t.Context(), srv.Client(), PendingDocument{SourceURL: srv.URL}, newTestSink(t), 2); err == nil {
		t.Fatal("persistent 500s must eventually fail")
	}
	if hits != 2 {
		t.Errorf("server saw %d requests, want 2 (maxAttempts)", hits)
	}
}

func TestIsRetryableFetchError(t *testing.T) {
	cases := []struct {
		status int
		want   bool
		why    string
	}{
		{http.StatusTooManyRequests, true, "429 is backpressure"},
		{http.StatusInternalServerError, true, "5xx is flakiness"},
		{http.StatusBadGateway, true, "5xx is flakiness"},
		{0, true, "no status means a transport failure"},
		{http.StatusNotFound, false, "404 will not fix itself"},
		{http.StatusForbidden, false, "403 is a policy decision, handled separately"},
	}
	for _, tc := range cases {
		if got := isRetryableFetchError(errors.New("boom"), tc.status); got != tc.want {
			t.Errorf("isRetryableFetchError(status=%d) = %v, want %v (%s)", tc.status, got, tc.want, tc.why)
		}
	}
	if isRetryableFetchError(nil, 500) {
		t.Error("a nil error is never retryable")
	}
}

func TestVerifyPDFMagic(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "good.pdf")
	if err := os.WriteFile(good, minimalPDF("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := verifyPDFMagic(good); err != nil {
		t.Errorf("verifyPDFMagic(good) = %v", err)
	}

	bad := filepath.Join(dir, "bad.pdf")
	if err := os.WriteFile(bad, []byte("<html>nope</html>"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := verifyPDFMagic(bad); err == nil {
		t.Error("verifyPDFMagic accepted HTML")
	}

	// A body shorter than the magic must not panic.
	short := filepath.Join(dir, "short.pdf")
	if err := os.WriteFile(short, []byte("%P"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := verifyPDFMagic(short); err == nil {
		t.Error("verifyPDFMagic accepted a truncated body")
	}
}

func TestLocalSinkRoundTrip(t *testing.T) {
	dir := t.TempDir()
	sink, err := newLocalSink(dir)
	if err != nil {
		t.Fatalf("newLocalSink: %v", err)
	}
	const sha = "abc123"

	exists, err := sink.Exists(t.Context(), sha)
	if err != nil || exists {
		t.Fatalf("Exists on empty sink = %v, %v", exists, err)
	}

	uri, n, err := sink.Put(t.Context(), sha, strings.NewReader("hello"))
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	if n != 5 {
		t.Errorf("Put wrote %d bytes, want 5", n)
	}
	if want := "file://" + filepath.Join(dir, sha+".pdf"); uri != want {
		t.Errorf("uri = %q, want %q", uri, want)
	}

	exists, err = sink.Exists(t.Context(), sha)
	if err != nil || !exists {
		t.Fatalf("Exists after Put = %v, %v", exists, err)
	}

	// Put must leave no temp files behind.
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".put-") {
			t.Errorf("temp file left behind: %s", e.Name())
		}
	}
}

func TestSinkURIForRoundTripsWithPut(t *testing.T) {
	sink := newTestSink(t)
	const sha = "deadbeef"
	uri, _, err := sink.Put(t.Context(), sha, strings.NewReader("x"))
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	// The dedup path reconstructs the URI without re-uploading, so the two must
	// agree or a deduped row records a URI that points nowhere.
	got, err := sinkURIFor(sink, sha)
	if err != nil {
		t.Fatalf("sinkURIFor: %v", err)
	}
	if got != uri {
		t.Errorf("sinkURIFor = %q, Put = %q", got, uri)
	}
}

func TestEnvIntFallsBackLoudly(t *testing.T) {
	t.Setenv("REGISTER_TEST_INT", "")
	if got := envInt("REGISTER_TEST_INT", 7); got != 7 {
		t.Errorf("unset = %d, want 7", got)
	}
	t.Setenv("REGISTER_TEST_INT", "42")
	if got := envInt("REGISTER_TEST_INT", 7); got != 42 {
		t.Errorf("set = %d, want 42", got)
	}
	t.Setenv("REGISTER_TEST_INT", "not-a-number")
	if got := envInt("REGISTER_TEST_INT", 7); got != 7 {
		t.Errorf("unparseable = %d, want the fallback 7", got)
	}
}

// The crawl must never start by accident against a parliamentary website.
func TestRegisterDryRunDefaultsTrue(t *testing.T) {
	t.Setenv("REGISTER_DRY_RUN", "")
	if !registerDryRun() {
		t.Error("REGISTER_DRY_RUN must default to true")
	}
	t.Setenv("REGISTER_DRY_RUN", "false")
	if registerDryRun() {
		t.Error("REGISTER_DRY_RUN=false must disable the dry run")
	}
	t.Setenv("REGISTER_DRY_RUN", "nonsense")
	if !registerDryRun() {
		t.Error("an unparseable value must fall back to the safe default")
	}
}

func sinkDir(t *testing.T, sink DocumentSink) string {
	t.Helper()
	ls, ok := sink.(*localSink)
	if !ok {
		t.Fatalf("expected a local sink, got %T", sink)
	}
	return ls.dir
}

// Compile-time guard: the sinks must satisfy the interface.
var (
	_ DocumentSink = (*localSink)(nil)
	_ DocumentSink = (*gcsSink)(nil)
)
