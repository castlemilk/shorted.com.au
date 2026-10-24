package resend

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testEmail() Email {
	return Email{
		From:    "Shorted Alerts <alerts@shorted.com.au>",
		To:      []string{"owner@example.com"},
		ReplyTo: "support@shorted.com.au",
		Subject: "BHP short interest crossed 5% (now 5.42%)",
		HTML:    "<p>hi</p>",
		Text:    "hi",
		Headers: map[string]string{"List-Unsubscribe": "<https://x/y?t=1>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"},
		Tags:    []Tag{{Name: "category", Value: "alert"}},
	}
}

func TestSendRequestShape(t *testing.T) {
	var got struct {
		method, path, auth, key, ctype string
		body                           map[string]any
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.method, got.path = r.Method, r.URL.Path
		got.auth = r.Header.Get("Authorization")
		got.key = r.Header.Get("Idempotency-Key")
		got.ctype = r.Header.Get("Content-Type")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &got.body)
		_, _ = w.Write([]byte(`{"id":"re_123"}`))
	}))
	defer srv.Close()

	c := &Client{APIKey: "test-key", BaseURL: srv.URL}
	id, err := c.Send(context.Background(), testEmail(), "alert-event-7")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if id != "re_123" {
		t.Fatalf("id = %q", id)
	}
	if got.method != http.MethodPost || got.path != "/emails" {
		t.Fatalf("request = %s %s", got.method, got.path)
	}
	if got.auth != "Bearer test-key" {
		t.Fatalf("Authorization = %q", got.auth)
	}
	if got.key != "alert-event-7" {
		t.Fatalf("Idempotency-Key = %q", got.key)
	}
	if got.ctype != "application/json" {
		t.Fatalf("Content-Type = %q", got.ctype)
	}
	if got.body["from"] != "Shorted Alerts <alerts@shorted.com.au>" || got.body["reply_to"] != "support@shorted.com.au" {
		t.Fatalf("from/reply_to not sent: %v", got.body)
	}
	headers, _ := got.body["headers"].(map[string]any)
	if headers["List-Unsubscribe-Post"] != "List-Unsubscribe=One-Click" || headers["List-Unsubscribe"] != "<https://x/y?t=1>" {
		t.Fatalf("headers not sent: %v", headers)
	}
	tags, _ := got.body["tags"].([]any)
	if len(tags) != 1 {
		t.Fatalf("tags not sent: %v", got.body["tags"])
	}
}

func TestSendAcceptedWithoutIDIsNotAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	id, err := (&Client{APIKey: "k", BaseURL: srv.URL}).Send(context.Background(), testEmail(), "k")
	if err != nil || id != "" {
		t.Fatalf("want accepted with empty id, got id=%q err=%v", id, err)
	}
}

func TestClassifyTable(t *testing.T) {
	cases := []struct {
		status int
		name   string
		want   Kind
	}{
		{400, "validation_error", KindPermanent},
		{422, "invalid_from_address", KindPermanent},
		{401, "missing_api_key", KindCredential},
		{403, "restricted_api_key", KindCredential},
		{409, "concurrent_idempotent_requests", KindRetryable},
		{409, "invalid_idempotent_request", KindPermanent},
		{429, "daily_quota_exceeded", KindQuota},
		{429, "monthly_quota_exceeded", KindQuota},
		{429, "rate_limit_exceeded", KindRateLimited},
		{500, "application_error", KindRetryable},
		{503, "", KindRetryable},
		{404, "not_found", KindPermanent},
	}
	for _, tc := range cases {
		if got := classify(tc.status, tc.name).Kind; got != tc.want {
			t.Errorf("classify(%d,%q) = %v, want %v", tc.status, tc.name, got, tc.want)
		}
	}
}

func TestSendErrorKindsOverTheWire(t *testing.T) {
	cases := []struct {
		status int
		body   string
		want   Kind
	}{
		{422, `{"name":"validation_error","message":"bad to@example.com"}`, KindPermanent},
		{401, `{"name":"missing_api_key"}`, KindCredential},
		{500, `oops`, KindRetryable},
		{429, `{"name":"daily_quota_exceeded"}`, KindQuota},
	}
	for _, tc := range cases {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(tc.status)
			_, _ = w.Write([]byte(tc.body))
		}))
		_, err := (&Client{APIKey: "k", BaseURL: srv.URL}).Send(context.Background(), testEmail(), "k")
		srv.Close()
		var se *SendError
		if !errors.As(err, &se) {
			t.Fatalf("status %d: want *SendError, got %v", tc.status, err)
		}
		if se.Kind != tc.want || se.Status != tc.status {
			t.Fatalf("status %d: got kind %v status %d, want kind %v", tc.status, se.Kind, se.Status, tc.want)
		}
		if se.Name == "" && tc.status == 422 {
			t.Fatalf("validation name lost")
		}
	}
}

func TestSendNeverKeepsMessageText(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(422)
		_, _ = w.Write([]byte(`{"name":"Bad Name with spaces","message":"owner@example.com is invalid"}`))
	}))
	defer srv.Close()
	_, err := (&Client{APIKey: "k", BaseURL: srv.URL}).Send(context.Background(), testEmail(), "k")
	var se *SendError
	if !errors.As(err, &se) {
		t.Fatalf("want SendError, got %v", err)
	}
	if se.Name != "" {
		t.Fatalf("a name with spaces must be dropped, got %q", se.Name)
	}
	if got := err.Error(); strings.Contains(got, "owner@") || strings.Contains(got, "example.com") {
		t.Fatalf("error text leaks the recipient: %q", got)
	}
}

func TestSendRetriesRateLimitOnceHonouringRetryAfter(t *testing.T) {
	var calls atomic.Int32
	var first, second time.Time
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n := calls.Add(1)
		if n == 1 {
			first = time.Now()
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(429)
			_, _ = w.Write([]byte(`{"name":"rate_limit_exceeded"}`))
			return
		}
		second = time.Now()
		_, _ = w.Write([]byte(`{"id":"re_retry"}`))
	}))
	defer srv.Close()
	id, err := (&Client{APIKey: "k", BaseURL: srv.URL}).Send(context.Background(), testEmail(), "k")
	if err != nil || id != "re_retry" {
		t.Fatalf("want success after retry, got id=%q err=%v", id, err)
	}
	if calls.Load() != 2 {
		t.Fatalf("calls = %d, want 2", calls.Load())
	}
	if gap := second.Sub(first); gap < 900*time.Millisecond {
		t.Fatalf("Retry-After not honoured: gap %v", gap)
	}
}

func TestSendGivesUpAfterSecondRateLimit(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.Header().Set("Retry-After", "0")
		w.WriteHeader(429)
		_, _ = w.Write([]byte(`{"name":"rate_limit_exceeded"}`))
	}))
	defer srv.Close()
	_, err := (&Client{APIKey: "k", BaseURL: srv.URL}).Send(context.Background(), testEmail(), "k")
	var se *SendError
	if !errors.As(err, &se) || se.Kind != KindRateLimited {
		t.Fatalf("want RateLimited after the one retry, got %v", err)
	}
	if calls.Load() != 2 {
		t.Fatalf("calls = %d, want exactly 2", calls.Load())
	}
}

func TestSendDailyQuotaIsNotRetried(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(429)
		_, _ = w.Write([]byte(`{"name":"daily_quota_exceeded"}`))
	}))
	defer srv.Close()
	_, err := (&Client{APIKey: "k", BaseURL: srv.URL}).Send(context.Background(), testEmail(), "k")
	var se *SendError
	if !errors.As(err, &se) || se.Kind != KindQuota {
		t.Fatalf("want Quota, got %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("a quota failure must not be retried, calls = %d", calls.Load())
	}
}

func TestSendNetworkFailureIsRetryable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := srv.URL
	srv.Close()
	_, err := (&Client{APIKey: "k", BaseURL: url}).Send(context.Background(), testEmail(), "k")
	var se *SendError
	if !errors.As(err, &se) || se.Kind != KindRetryable {
		t.Fatalf("want Retryable for a refused connection, got %v", err)
	}
}

func TestBaseURLOverrideAndTrailingSlash(t *testing.T) {
	var path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		_, _ = w.Write([]byte(`{"id":"x"}`))
	}))
	defer srv.Close()
	if _, err := (&Client{APIKey: "k", BaseURL: srv.URL + "/"}).Send(context.Background(), testEmail(), "k"); err != nil {
		t.Fatal(err)
	}
	if path != "/emails" {
		t.Fatalf("path = %q, want /emails", path)
	}
}

func TestParseRetryAfter(t *testing.T) {
	if parseRetryAfter("3") != 3*time.Second || parseRetryAfter("") != 0 || parseRetryAfter("-1") != 0 || parseRetryAfter("Wed, 21 Oct") != 0 {
		t.Fatal("Retry-After parsing drifted")
	}
}

// Inline attachments use Resend's documented shape: content base64, and a
// content_id that the HTML references as cid:. An email without attachments
// carries no attachments key at all.
func TestEmailAttachmentJSONShape(t *testing.T) {
	e := Email{
		From: "a@example.test", To: []string{"b@example.test"}, Subject: "s", HTML: "<img src=\"cid:chart\">", Text: "t",
		Attachments: []Attachment{{Filename: "chart.png", Content: "aGk=", ContentType: "image/png", ContentID: "chart"}},
	}
	got, err := json.Marshal(e)
	if err != nil {
		t.Fatal(err)
	}
	const want = `"attachments":[{"filename":"chart.png","content":"aGk=","content_type":"image/png","content_id":"chart"}]`
	if !strings.Contains(string(got), want) {
		t.Fatalf("attachment JSON = %s, want it to contain %s", got, want)
	}
	plain, _ := json.Marshal(Email{From: "a", To: []string{"b"}, Subject: "s", HTML: "h", Text: "t"})
	if strings.Contains(string(plain), "attachments") {
		t.Fatalf("an email without attachments must omit the key: %s", plain)
	}
}
