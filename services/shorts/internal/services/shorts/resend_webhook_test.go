package shorts

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
	"github.com/castlemilk/shorted.com.au/services/pkg/resend"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

var webhookKey = []byte("webhook-test-key-0123456789abcdef")
var webhookSecret = "whsec_" + base64.StdEncoding.EncodeToString(webhookKey)

var webhookNow = time.Unix(1_800_000_000, 0)

// signedRequest builds a POST the way Resend sends it, signed with key.
func signedRequest(t *testing.T, key []byte, body string) *http.Request {
	t.Helper()
	ts := strconv.FormatInt(webhookNow.Unix(), 10)
	m := hmac.New(sha256.New, key)
	m.Write([]byte("msg_test." + ts + "."))
	m.Write([]byte(body))
	req := httptest.NewRequest(http.MethodPost, ResendWebhookPath, strings.NewReader(body))
	req.Header.Set("svix-id", "msg_test")
	req.Header.Set("svix-timestamp", ts)
	req.Header.Set("svix-signature", "v1,"+base64.StdEncoding.EncodeToString(m.Sum(nil)))
	return req
}

type fakeFeedbackStore struct {
	calls   int
	gotID   string
	gotStat string
	gotWhy  string
	gotTo   []string
	result  shortsstore.ResendFeedbackResult
	err     error
}

func (f *fakeFeedbackStore) RecordResendFeedback(_ context.Context, emailID, status, reason string, addresses []string) (shortsstore.ResendFeedbackResult, error) {
	f.calls++
	f.gotID, f.gotStat, f.gotWhy, f.gotTo = emailID, status, reason, addresses
	return f.result, f.err
}

type notice struct{ subject, text string }

func runWebhook(t *testing.T, secret string, store ResendWebhookStore, notify func(context.Context, string, string) error, req *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	h := NewResendWebhookHandler(ResendWebhookConfig{
		Secret: secret,
		Store:  store,
		Notify: notify,
		Now:    func() time.Time { return webhookNow },
		Infof:  func(string, ...any) {},
		Errorf: func(string, ...any) {},
	})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

const bouncedBody = `{"type":"email.bounced","data":{"email_id":"em_42","to":["Ops@Corp.example"],"bounce":{"type":"Permanent","message":"no mailbox"}}}`
const complainedBody = `{"type":"email.complained","data":{"email_id":"em_43","to":["ops@corp.example"]}}`

func TestWebhookWithoutSecretIsRefusedAndTouchesNothing(t *testing.T) {
	store := &fakeFeedbackStore{}
	rec := runWebhook(t, "", store, nil, signedRequest(t, webhookKey, bouncedBody))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	if store.calls != 0 {
		t.Fatal("an unconfigured endpoint must not write")
	}
}

func TestWebhookRejectsBadSignatures(t *testing.T) {
	cases := map[string]func(*http.Request){
		"signed with another key": func(r *http.Request) {
			*r = *signedRequest(t, []byte("some-other-key-entirely-xxxxxxxx"), bouncedBody)
		},
		"unsigned": func(r *http.Request) {
			r.Header.Del("svix-signature")
		},
		"stale timestamp": func(r *http.Request) {
			r.Header.Set("svix-timestamp", strconv.FormatInt(webhookNow.Add(-time.Hour).Unix(), 10))
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			store := &fakeFeedbackStore{}
			req := signedRequest(t, webhookKey, bouncedBody)
			mutate(req)
			rec := runWebhook(t, webhookSecret, store, nil, req)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", rec.Code)
			}
			if store.calls != 0 {
				t.Fatal("an unsigned event must not write")
			}
		})
	}
}

func TestWebhookPermanentBounceMarksAndSuppresses(t *testing.T) {
	store := &fakeFeedbackStore{result: shortsstore.ResendFeedbackResult{Deliveries: 1, NewlySuppressed: []string{"ops@corp.example"}}}
	var got []notice
	notify := func(_ context.Context, s, b string) error { got = append(got, notice{s, b}); return nil }

	rec := runWebhook(t, webhookSecret, store, notify, signedRequest(t, webhookKey, bouncedBody))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if store.calls != 1 || store.gotStat != "bounced" || store.gotWhy != "bounced" || store.gotID != "em_42" {
		t.Fatalf("store got status=%q reason=%q id=%q calls=%d", store.gotStat, store.gotWhy, store.gotID, store.calls)
	}
	if len(store.gotTo) != 1 || store.gotTo[0] != "Ops@Corp.example" {
		t.Fatalf("addresses passed through as %v", store.gotTo)
	}
	if len(got) != 1 {
		t.Fatalf("operator notices = %d, want 1", len(got))
	}
	if !strings.Contains(got[0].subject, "bounced") || !strings.Contains(got[0].text, "ops@corp.example") {
		t.Fatalf("operator notice = %+v", got[0])
	}
}

func TestWebhookComplaintMarksAndSuppresses(t *testing.T) {
	store := &fakeFeedbackStore{result: shortsstore.ResendFeedbackResult{Deliveries: 1, NewlySuppressed: []string{"ops@corp.example"}}}
	notices := 0
	notify := func(context.Context, string, string) error { notices++; return nil }

	rec := runWebhook(t, webhookSecret, store, notify, signedRequest(t, webhookKey, complainedBody))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if store.gotStat != "complained" || store.gotWhy != "complained" {
		t.Fatalf("store got status=%q reason=%q, want complained", store.gotStat, store.gotWhy)
	}
	if notices != 1 {
		t.Fatalf("operator notices = %d, want 1", notices)
	}
}

func TestWebhookTransientBounceIsIgnored(t *testing.T) {
	body := `{"type":"email.bounced","data":{"email_id":"em_44","to":["a@example.com"],"bounce":{"type":"Transient"}}}`
	store := &fakeFeedbackStore{}
	rec := runWebhook(t, webhookSecret, store, nil, signedRequest(t, webhookKey, body))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 so Resend does not retry", rec.Code)
	}
	if store.calls != 0 {
		t.Fatal("a transient bounce must not suppress the address")
	}
}

func TestWebhookIgnoresOtherEvents(t *testing.T) {
	body := `{"type":"email.delivered","data":{"email_id":"em_45","to":["a@example.com"]}}`
	store := &fakeFeedbackStore{}
	rec := runWebhook(t, webhookSecret, store, nil, signedRequest(t, webhookKey, body))
	if rec.Code != http.StatusOK || store.calls != 0 {
		t.Fatalf("status=%d calls=%d, want 200 and no write", rec.Code, store.calls)
	}
}

func TestWebhookRepeatDoesNotNotifyTwice(t *testing.T) {
	// The second delivery of the same event suppresses nothing new, so no notice.
	store := &fakeFeedbackStore{result: shortsstore.ResendFeedbackResult{Deliveries: 1}}
	notices := 0
	notify := func(context.Context, string, string) error { notices++; return nil }
	rec := runWebhook(t, webhookSecret, store, notify, signedRequest(t, webhookKey, bouncedBody))
	if rec.Code != http.StatusOK || notices != 0 {
		t.Fatalf("status=%d notices=%d, want 200 and no notice", rec.Code, notices)
	}
}

func TestWebhookStoreFailureReturns500ForRetry(t *testing.T) {
	store := &fakeFeedbackStore{err: errors.New("db down")}
	rec := runWebhook(t, webhookSecret, store, nil, signedRequest(t, webhookKey, bouncedBody))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 so Resend retries", rec.Code)
	}
}

func TestWebhookNoticeFailureDoesNotFailTheEvent(t *testing.T) {
	store := &fakeFeedbackStore{result: shortsstore.ResendFeedbackResult{NewlySuppressed: []string{"a@example.com"}}}
	notify := func(context.Context, string, string) error { return fmt.Errorf("resend down") }
	rec := runWebhook(t, webhookSecret, store, notify, signedRequest(t, webhookKey, bouncedBody))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: the feedback was recorded", rec.Code)
	}
}

func TestWebhookRejectsGetAndMalformedBody(t *testing.T) {
	store := &fakeFeedbackStore{}
	get := httptest.NewRequest(http.MethodGet, ResendWebhookPath, nil)
	if rec := runWebhook(t, webhookSecret, store, nil, get); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status = %d, want 405", rec.Code)
	}
	if rec := runWebhook(t, webhookSecret, store, nil, signedRequest(t, webhookKey, "not json")); rec.Code != http.StatusBadRequest {
		t.Fatalf("malformed status = %d, want 400", rec.Code)
	}
	if store.calls != 0 {
		t.Fatal("a rejected request must not write")
	}
}

// Mutation check for the suppression decision: a transient bounce must never reach
// the store. feedbackFor is the single place that decides, so pin it directly too.
func TestFeedbackForOnlySuppressesPermanentBouncesAndComplaints(t *testing.T) {
	if _, _, act := feedbackFor(resendEvent("email.bounced", "Permanent")); !act {
		t.Fatal("a permanent bounce must act")
	}
	if _, _, act := feedbackFor(resendEvent("email.bounced", "Undetermined")); act {
		t.Fatal("an undetermined bounce must not act")
	}
	if _, _, act := feedbackFor(resendEvent("email.complained", "")); !act {
		t.Fatal("a complaint must act")
	}
	if _, _, act := feedbackFor(resendEvent("email.delivered", "")); act {
		t.Fatal("a delivery must not act")
	}
}

func TestResendOperatorNotifierIsNilWithoutKeyOrRecipient(t *testing.T) {
	if ResendOperatorNotifier("", "from", "to@example.com") != nil {
		t.Fatal("no API key means no notifier")
	}
	if ResendOperatorNotifier("re_key", "from", "") != nil {
		t.Fatal("no recipient means no notifier")
	}
	if ResendOperatorNotifier("re_key", "from", "to@example.com") == nil {
		t.Fatal("a configured notifier must exist")
	}
}

func resendEvent(typ, bounceType string) resend.WebhookEvent {
	return resend.WebhookEvent{Type: typ, BounceType: bounceType}
}

// The API reads feedback-driven states as failed (the alert did not reach the
// customer), never as the unspecified state, which clients show as "unknown".
func TestFeedbackStatesReadAsFailedInTheAPI(t *testing.T) {
	want := shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_FAILED
	for _, status := range []string{alertevents.StatusBounced, alertevents.StatusComplained, alertevents.StatusSkippedSuppressed} {
		if got := alertDeliveryStatusFromStore(status); got != want {
			t.Fatalf("%s reads as %v, want FAILED", status, got)
		}
	}
}
