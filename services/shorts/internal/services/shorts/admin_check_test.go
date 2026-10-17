package shorts

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func newTestAdminChecker(t *testing.T, handler http.HandlerFunc) (*adminChecker, *time.Time) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	now := time.Date(2026, 9, 25, 9, 0, 0, 0, time.UTC)
	c := &adminChecker{
		url: srv.URL, secret: "internal", client: srv.Client(),
		now: func() time.Time { return now }, cache: map[string]adminCheckEntry{},
	}
	return c, &now
}

func TestAdminCheckerSendsTheSecretAndParsesTheAnswer(t *testing.T) {
	c, _ := newTestAdminChecker(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if r.Header.Get("x-internal-secret") != "internal" || body["user_id"] != "uid-admin" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		_, _ = w.Write([]byte(`{"admin":true}`))
	})
	ok, err := c.IsAdmin(context.Background(), "uid-admin")
	if err != nil || !ok {
		t.Fatalf("IsAdmin = %v, %v", ok, err)
	}
}

func TestAdminCheckerCachesAndExpires(t *testing.T) {
	var calls atomic.Int32
	answer := `{"admin":true}`
	c, now := newTestAdminChecker(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(answer))
	})
	for i := 0; i < 3; i++ {
		if ok, _ := c.IsAdmin(context.Background(), "uid-1"); !ok {
			t.Fatal("want admin")
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d, want 1 (cached)", calls.Load())
	}
	// Revoked upstream: visible once the positive TTL lapses.
	answer = `{"admin":false}`
	*now = now.Add(adminCheckPositiveTTL + time.Second)
	if ok, _ := c.IsAdmin(context.Background(), "uid-1"); ok {
		t.Fatal("revocation not visible after the TTL")
	}
}

func TestAdminCheckerFailsClosedAndDoesNotCacheErrors(t *testing.T) {
	var calls atomic.Int32
	status := http.StatusServiceUnavailable
	c, _ := newTestAdminChecker(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		if status != http.StatusOK {
			w.WriteHeader(status)
			return
		}
		_, _ = w.Write([]byte(`{"admin":true}`))
	})
	if ok, err := c.IsAdmin(context.Background(), "uid-1"); ok || err == nil {
		t.Fatalf("IsAdmin on 503 = %v, %v; want false + error", ok, err)
	}
	status = http.StatusOK
	if ok, err := c.IsAdmin(context.Background(), "uid-1"); !ok || err != nil {
		t.Fatalf("after recovery IsAdmin = %v, %v", ok, err)
	}
	if calls.Load() != 2 {
		t.Fatalf("calls = %d: an error must not be cached", calls.Load())
	}
}

func TestAdminCheckerRejectsAMalformedAnswer(t *testing.T) {
	for _, body := range []string{`{}`, `not json`, `{"admin":"yes"}`} {
		c, _ := newTestAdminChecker(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(body)) })
		if ok, err := c.IsAdmin(context.Background(), "uid-1"); ok || err == nil {
			t.Fatalf("body %q: IsAdmin = %v, %v; want false + error", body, ok, err)
		}
	}
}

func TestAdminCheckerNeedsTheInternalSecret(t *testing.T) {
	t.Setenv("INTERNAL_SERVICE_SECRET", "")
	if newAdminCheckerFromEnv() != nil {
		t.Fatal("without an internal secret there must be no admin checker (fail closed)")
	}
}
