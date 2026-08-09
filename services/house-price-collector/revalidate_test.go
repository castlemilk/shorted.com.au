package main

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

type revalidateRoundTripFunc func(*http.Request) (*http.Response, error)

func (f revalidateRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func useRevalidateTransport(t *testing.T, fn revalidateRoundTripFunc) {
	t.Helper()
	previous := http.DefaultClient.Transport
	http.DefaultClient.Transport = fn
	t.Cleanup(func() { http.DefaultClient.Transport = previous })
}

func revalidateResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}

// TestPingRevalidateSendsExpectedQuery asserts the secret is carried in a
// header (never the logged URL) alongside the housing cache-bust query.
func TestPingRevalidateSendsExpectedQuery(t *testing.T) {
	var got *http.Request
	useRevalidateTransport(t, func(r *http.Request) (*http.Response, error) {
		got = r
		return revalidateResponse(http.StatusOK, `{"revalidated":true}`), nil
	})

	t.Setenv("REVALIDATION_URL", "https://revalidate.invalid/api/revalidate")
	t.Setenv("REVALIDATION_SECRET", "s3cr3t")

	pingRevalidate("test")

	if got == nil {
		t.Fatal("expected a revalidation request, got none")
	}

	if got.Method != http.MethodPost {
		t.Errorf("method = %s, want POST", got.Method)
	}
	q := got.URL.Query()
	if got.Header.Get("X-Revalidate-Secret") != "s3cr3t" {
		t.Errorf("X-Revalidate-Secret = %q, want s3cr3t", got.Header.Get("X-Revalidate-Secret"))
	}
	if _, ok := q["secret"]; ok {
		t.Errorf("secret must not ride in query string, got %q", q.Get("secret"))
	}
	if q.Get("path") != "/price-drops,/housing" {
		t.Errorf("path = %q, want /price-drops,/housing", q.Get("path"))
	}
	if q.Get("flush") != "housing" {
		t.Errorf("flush = %q, want housing", q.Get("flush"))
	}
	if _, ok := q["tag"]; ok {
		t.Errorf("tag must be unset, got %q", q.Get("tag"))
	}
}

// TestPingRevalidateSkipsWhenUnset asserts the ping is a no-op (no HTTP request)
// when either env var is empty — so an unconfigured collector never errors.
func TestPingRevalidateSkipsWhenUnset(t *testing.T) {
	hits := 0
	useRevalidateTransport(t, func(r *http.Request) (*http.Response, error) {
		hits++
		return revalidateResponse(http.StatusOK, ""), nil
	})

	cases := []struct {
		name   string
		url    string
		secret string
	}{
		{"both empty", "", ""},
		{"url set, secret empty", "https://revalidate.invalid", ""},
		{"secret set, url empty", "", "s3cr3t"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("REVALIDATION_URL", tc.url)
			t.Setenv("REVALIDATION_SECRET", tc.secret)

			pingRevalidate("test")

		})
	}
	if hits != 0 {
		t.Fatalf("no HTTP request should be sent when a revalidation env var is unset, got %d", hits)
	}
}

// TestPingRevalidateToleratesNon2xx asserts a non-2xx response is logged as a
// warning but never panics or blocks — the run continues unaffected.
func TestPingRevalidateToleratesNon2xx(t *testing.T) {
	useRevalidateTransport(t, func(r *http.Request) (*http.Response, error) {
		return revalidateResponse(http.StatusInternalServerError, "upstream boom"), nil
	})

	t.Setenv("REVALIDATION_URL", "https://revalidate.invalid")
	t.Setenv("REVALIDATION_SECRET", "s3cr3t")

	// Must return normally despite the 5xx (no panic, no error propagation).
	pingRevalidate("test")
}
