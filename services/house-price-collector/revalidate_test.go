package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestPingRevalidateSendsExpectedQuery asserts the ping POSTs to the configured
// endpoint with exactly the housing cache-bust query contract: secret + a
// path=/price-drops,/housing + flush=housing, and NO tag param.
func TestPingRevalidateSendsExpectedQuery(t *testing.T) {
	reqCh := make(chan *http.Request, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqCh <- r
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"revalidated":true}`))
	}))
	defer srv.Close()

	t.Setenv("REVALIDATION_URL", srv.URL)
	t.Setenv("REVALIDATION_SECRET", "s3cr3t")

	pingRevalidate("test")

	var got *http.Request
	select {
	case got = <-reqCh:
	case <-time.After(5 * time.Second):
		t.Fatal("expected a revalidation request, got none")
	}

	if got.Method != http.MethodPost {
		t.Errorf("method = %s, want POST", got.Method)
	}
	q := got.URL.Query()
	if q.Get("secret") != "s3cr3t" {
		t.Errorf("secret = %q, want s3cr3t", q.Get("secret"))
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
	hits := make(chan struct{}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits <- struct{}{}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	cases := []struct {
		name   string
		url    string
		secret string
	}{
		{"both empty", "", ""},
		{"url set, secret empty", srv.URL, ""},
		{"secret set, url empty", "", "s3cr3t"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("REVALIDATION_URL", tc.url)
			t.Setenv("REVALIDATION_SECRET", tc.secret)

			pingRevalidate("test")

			select {
			case <-hits:
				t.Fatal("no HTTP request should be sent when a revalidation env var is unset")
			case <-time.After(150 * time.Millisecond):
				// no request — expected
			}
		})
	}
}

// TestPingRevalidateToleratesNon2xx asserts a non-2xx response is logged as a
// warning but never panics or blocks — the run continues unaffected.
func TestPingRevalidateToleratesNon2xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("upstream boom"))
	}))
	defer srv.Close()

	t.Setenv("REVALIDATION_URL", srv.URL)
	t.Setenv("REVALIDATION_SECRET", "s3cr3t")

	// Must return normally despite the 5xx (no panic, no error propagation).
	pingRevalidate("test")
}
