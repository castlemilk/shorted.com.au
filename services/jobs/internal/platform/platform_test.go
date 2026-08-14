package platform

import (
	"bytes"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

type platformRoundTripFunc func(*http.Request) (*http.Response, error)

func (f platformRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func usePlatformTransport(t *testing.T, fn platformRoundTripFunc) {
	t.Helper()
	previous := http.DefaultClient.Transport
	http.DefaultClient.Transport = fn
	t.Cleanup(func() { http.DefaultClient.Transport = previous })
}

func platformResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}

// captureLog redirects the standard logger for the duration of fn.
func captureLog(t *testing.T, fn func()) string {
	t.Helper()
	var buf bytes.Buffer
	prevOut := log.Writer()
	prevFlags := log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	t.Cleanup(func() {
		log.SetOutput(prevOut)
		log.SetFlags(prevFlags)
	})
	fn()
	return buf.String()
}

const testSecret = "s3cr3t-revalidation-token"

func TestPingRevalidateNoOpsWhenUnconfigured(t *testing.T) {
	var hits int
	usePlatformTransport(t, func(r *http.Request) (*http.Response, error) {
		hits++
		return platformResponse(http.StatusOK, ""), nil
	})

	tests := []struct {
		name        string
		url, secret string
	}{
		{"both unset", "", ""},
		{"url only", "https://revalidate.invalid", ""},
		{"secret only", "", testSecret},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("REVALIDATION_URL", tt.url)
			t.Setenv("REVALIDATION_SECRET", tt.secret)

			out := captureLog(t, func() {
				PingRevalidate(RevalidateRequest{Reason: "test", Paths: []string{"/housing"}, Flush: "housing"})
			})
			if !strings.Contains(out, "skipping cache bust") {
				t.Errorf("want a skip log line, got %q", out)
			}
			if strings.Contains(out, testSecret) {
				t.Errorf("secret leaked into logs: %q", out)
			}
		})
	}
	if hits != 0 {
		t.Fatalf("unconfigured ping must not hit the network, got %d request(s)", hits)
	}
}

func TestPingRevalidateSuccess(t *testing.T) {
	type capture struct {
		method string
		path   string
		query  url.Values
		secret string
	}
	var got capture
	usePlatformTransport(t, func(r *http.Request) (*http.Response, error) {
		got = capture{method: r.Method, path: r.URL.Path, query: r.URL.Query(), secret: r.Header.Get("X-Revalidate-Secret")}
		return platformResponse(http.StatusOK, ""), nil
	})

	t.Setenv("REVALIDATION_URL", "https://revalidate.invalid/api/revalidate")
	t.Setenv("REVALIDATION_SECRET", testSecret)

	out := captureLog(t, func() {
		PingRevalidate(RevalidateRequest{
			Reason: "listings",
			Paths:  []string{"/price-drops", "/housing"},
			Flush:  "shorts,housing",
		})
	})

	if got.method != http.MethodPost {
		t.Errorf("want POST, got %q", got.method)
	}
	if got.path != "/api/revalidate" {
		t.Errorf("want /api/revalidate, got %q", got.path)
	}
	if p := got.query.Get("path"); p != "/price-drops,/housing" {
		t.Errorf("want comma-joined paths, got %q", p)
	}
	if f := got.query.Get("flush"); f != "shorts,housing" {
		t.Errorf("want flush families, got %q", f)
	}
	if got.secret != testSecret {
		t.Errorf("header secret not forwarded, got %q", got.secret)
	}
	if _, ok := got.query["secret"]; ok {
		t.Errorf("secret must not ride in query string: %v", got.query)
	}
	if !strings.Contains(out, "cache bust ok (status 200)") {
		t.Errorf("want success log, got %q", out)
	}
	if strings.Contains(out, testSecret) {
		t.Errorf("secret leaked into logs: %q", out)
	}
}

// The weekly-report job busts by TAG rather than by path; the tag must ride the
// query string and no empty path/flush params may be sent.
func TestPingRevalidateTagOnly(t *testing.T) {
	var query url.Values
	var secret string
	usePlatformTransport(t, func(r *http.Request) (*http.Response, error) {
		query = r.URL.Query()
		secret = r.Header.Get("X-Revalidate-Secret")
		return platformResponse(http.StatusOK, ""), nil
	})

	t.Setenv("REVALIDATION_URL", "https://revalidate.invalid/api/revalidate")
	t.Setenv("REVALIDATION_SECRET", testSecret)

	out := captureLog(t, func() {
		PingRevalidate(RevalidateRequest{Reason: "weekly-report", Tag: "report-2026-W06"})
	})

	if got := query.Get("tag"); got != "report-2026-W06" {
		t.Errorf("tag = %q, want report-2026-W06", got)
	}
	if _, ok := query["path"]; ok {
		t.Errorf("path must be omitted when no paths are given: %v", query)
	}
	if _, ok := query["flush"]; ok {
		t.Errorf("flush must be omitted when unset: %v", query)
	}
	if secret != testSecret {
		t.Errorf("header secret not forwarded: %q", secret)
	}
	if _, ok := query["secret"]; ok {
		t.Errorf("secret must not ride in query string: %v", query)
	}
	if strings.Contains(out, testSecret) {
		t.Errorf("secret leaked into logs: %q", out)
	}
}

func TestPingRevalidateNonSuccessWarnsWithoutSecret(t *testing.T) {
	usePlatformTransport(t, func(r *http.Request) (*http.Response, error) {
		return platformResponse(http.StatusUnauthorized, "invalid secret"), nil
	})

	t.Setenv("REVALIDATION_URL", "https://revalidate.invalid")
	t.Setenv("REVALIDATION_SECRET", testSecret)

	out := captureLog(t, func() {
		PingRevalidate(RevalidateRequest{Reason: "refresh", Paths: []string{"/housing"}})
	})
	if !strings.Contains(out, "non-2xx (status 401)") {
		t.Errorf("want non-2xx warning, got %q", out)
	}
	if !strings.Contains(out, "invalid secret") {
		t.Errorf("want the response snippet in the warning, got %q", out)
	}
	if strings.Contains(out, testSecret) {
		t.Errorf("secret leaked into logs: %q", out)
	}
}

// A transport failure yields a *url.Error carrying the full URL. The log line
// must redact it even though the secret now travels in a header.
func TestPingRevalidateTransportErrorRedactsURL(t *testing.T) {
	closed := "https://revalidate.invalid"
	usePlatformTransport(t, func(r *http.Request) (*http.Response, error) {
		return nil, errors.New("dial failed")
	})

	t.Setenv("REVALIDATION_URL", closed)
	t.Setenv("REVALIDATION_SECRET", testSecret)

	out := captureLog(t, func() {
		PingRevalidate(RevalidateRequest{Reason: "agent", Paths: []string{"/housing"}})
	})
	if !strings.Contains(out, "revalidation ping failed") {
		t.Fatalf("want a failure log, got %q", out)
	}
	if strings.Contains(out, testSecret) {
		t.Errorf("secret leaked into logs: %q", out)
	}
	if strings.Contains(out, closed) {
		t.Errorf("request URL leaked into logs: %q", out)
	}
	if !strings.Contains(out, "[url redacted]") {
		t.Errorf("want the redaction marker, got %q", out)
	}
}

func TestGetEnv(t *testing.T) {
	tests := []struct {
		name, set, def, want string
	}{
		{"unset uses default", "", "fallback", "fallback"},
		{"blank uses default", "   ", "fallback", "fallback"},
		{"set wins", "value", "fallback", "value"},
		{"trimmed", "  value  ", "fallback", "value"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("JOBS_TEST_STR", tt.set)
			if got := GetEnv("JOBS_TEST_STR", tt.def); got != tt.want {
				t.Errorf("GetEnv() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestRequireEnv(t *testing.T) {
	t.Run("set", func(t *testing.T) {
		t.Setenv("JOBS_TEST_REQ", " ok ")
		got, err := RequireEnv("JOBS_TEST_REQ")
		if err != nil || got != "ok" {
			t.Fatalf("RequireEnv() = %q, %v", got, err)
		}
	})
	t.Run("blank errors", func(t *testing.T) {
		t.Setenv("JOBS_TEST_REQ", "  ")
		if _, err := RequireEnv("JOBS_TEST_REQ"); err == nil ||
			!strings.Contains(err.Error(), "JOBS_TEST_REQ is required") {
			t.Fatalf("want required error, got %v", err)
		}
	})
}

func TestGetEnvBool(t *testing.T) {
	tests := []struct {
		set  string
		def  bool
		want bool
	}{
		{"", true, true},
		{"", false, false},
		{"1", false, true},
		{"true", false, true},
		{"TRUE", false, true},
		{"Yes", false, true},
		{" on ", false, true},
		{"0", true, false},
		{"false", true, false},
		{"no", true, false},
		{"off", true, false},
		{"maybe", true, true},
		{"maybe", false, false},
	}
	for _, tt := range tests {
		t.Run(tt.set+"/"+boolName(tt.def), func(t *testing.T) {
			t.Setenv("JOBS_TEST_BOOL", tt.set)
			if got := GetEnvBool("JOBS_TEST_BOOL", tt.def); got != tt.want {
				t.Errorf("GetEnvBool(%q, %v) = %v, want %v", tt.set, tt.def, got, tt.want)
			}
		})
	}
}

func boolName(b bool) string {
	if b {
		return "def-true"
	}
	return "def-false"
}

func TestGetEnvInt(t *testing.T) {
	tests := []struct {
		name string
		set  string
		def  int
		want int
	}{
		{"unset", "", 7, 7},
		{"parsed", "42", 7, 42},
		{"negative", "-3", 7, -3},
		{"padded", "  8  ", 7, 8},
		{"unparseable falls back", "twelve", 7, 7},
		{"float falls back", "1.5", 7, 7},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("JOBS_TEST_INT", tt.set)
			if got := GetEnvInt("JOBS_TEST_INT", tt.def); got != tt.want {
				t.Errorf("GetEnvInt(%q, %d) = %d, want %d", tt.set, tt.def, got, tt.want)
			}
		})
	}
}

func TestGetEnvDuration(t *testing.T) {
	tests := []struct {
		name string
		set  string
		def  time.Duration
		want time.Duration
	}{
		{"unset", "", 2 * time.Second, 2 * time.Second},
		{"parsed", "90s", 2 * time.Second, 90 * time.Second},
		{"compound", "1h30m", time.Second, 90 * time.Minute},
		{"padded", " 250ms ", time.Second, 250 * time.Millisecond},
		{"unitless falls back", "30", time.Second, time.Second},
		{"garbage falls back", "soon", time.Second, time.Second},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("JOBS_TEST_DUR", tt.set)
			if got := GetEnvDuration("JOBS_TEST_DUR", tt.def); got != tt.want {
				t.Errorf("GetEnvDuration(%q, %s) = %s, want %s", tt.set, tt.def, got, tt.want)
			}
		})
	}
}

func TestConnectRejectsEmptyURL(t *testing.T) {
	if _, err := Connect(t.Context(), ""); err == nil ||
		!strings.Contains(err.Error(), "database url is empty") {
		t.Fatalf("want empty-url error, got %v", err)
	}
}
