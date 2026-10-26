package alerts

import (
	"errors"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/resend"
)

// TestWantCanaryDecisionTable is the canary rule of the spec: auto sends the daily
// proof, and sends one before any customer mail in the same pass. always sends every
// pass. off sends none.
func TestWantCanaryDecisionTable(t *testing.T) {
	cases := []struct {
		mode    string
		claimed int
		due     bool
		want    bool
	}{
		{canaryAuto, 0, false, false},
		{canaryAuto, 0, true, true},
		{canaryAuto, 3, false, true},
		{canaryAuto, 3, true, true},
		{canaryAlways, 0, false, true},
		{canaryOff, 0, true, false},
		{canaryOff, 9, true, false},
	}
	for _, tc := range cases {
		if got := wantCanary(tc.mode, tc.claimed, tc.due); got != tc.want {
			t.Errorf("wantCanary(%s, claimed=%d, due=%v) = %v, want %v", tc.mode, tc.claimed, tc.due, got, tc.want)
		}
	}
}

// TestDescribeSendErrorNeverCarriesTheBody checks the log and last_error text: the
// kind and status only, never a recipient address or a response message.
func TestDescribeSendErrorNeverCarriesTheBody(t *testing.T) {
	err := &resend.SendError{Kind: resend.KindPermanent, Status: 422, Name: "validation_error"}
	got := describeSendError(err)
	if got != "resend: permanent (status 422, validation_error)" {
		t.Fatalf("describe = %q", got)
	}
	if describeSendError(errors.New("owner@example.com")) == "owner@example.com" {
		t.Fatal("a non-Resend error must not echo its text")
	}
}

func TestDegradedReasonCoversEveryNotSentCase(t *testing.T) {
	if reason := degradedReason(Plan{}, deliveryStats{}); reason != "" {
		t.Fatalf("a clean run is not degraded: %q", reason)
	}
	if reason := degradedReason(Plan{Held: "2026-10-16"}, deliveryStats{}); reason == "" {
		t.Fatal("a held date degrades the run")
	}
	if reason := degradedReason(Plan{}, deliveryStats{retrying: 1}); reason == "" {
		t.Fatal("an email still retrying degrades the run")
	}
	if reason := degradedReason(Plan{}, deliveryStats{failed: 1}); reason == "" {
		t.Fatal("a failed email degrades the run")
	}
	if reason := degradedReason(Plan{}, deliveryStats{quota: true}); reason == "" {
		t.Fatal("a spent quota degrades the run")
	}
	if exitCode(Plan{}, deliveryStats{}) != 0 || exitCode(Plan{}, deliveryStats{failed: 1}) != exitDegraded {
		t.Fatal("exit codes drifted")
	}
}

// TestIdempotencyKeyIsStablePerRowAndUniqueAcrossDatabases pins the two properties
// Resend's account-wide 24-hour key window needs. A retry of one row must reuse its
// key, so a crash after the send is deduplicated. Row 1 of another database, such as
// a test run on the same Resend account, must not, or Resend refuses the real email
// with 409 invalid_idempotent_request.
func TestIdempotencyKeyIsStablePerRowAndUniqueAcrossDatabases(t *testing.T) {
	created := time.Date(2026, 10, 24, 9, 46, 26, 123456000, time.UTC)
	key := idempotencyKey("event", 1, created)
	if want := "alert-event-1-1792835186123456"; key != want {
		t.Fatalf("key = %q, want %q", key, want)
	}
	if again := idempotencyKey("event", 1, created.In(time.FixedZone("AEST", 10*3600))); again != key {
		t.Fatalf("the same instant in another zone gave %q, want %q", again, key)
	}
	if other := idempotencyKey("event", 1, created.Add(time.Microsecond)); other == key {
		t.Fatalf("row 1 of another database reused key %q", key)
	}
	if canary := idempotencyKey("canary", 1, created); canary == key {
		t.Fatalf("a canary and an event share key %q", key)
	}
}
