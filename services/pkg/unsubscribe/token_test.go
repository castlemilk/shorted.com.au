package unsubscribe

import "testing"

const secret = "test-secret"

// The same literal is pinned in services/shorts/internal/services/register. Links
// already sent in broadcasts carry this shape, so it must never change.
func TestSignGoldenVector(t *testing.T) {
	const want = "c3ViLTEyMw.kd23woUzqLIEeZDOdSd45JX5ngOjmNL0lZ4mR0TfnQk"
	if got := Sign("sub-123", "test-secret"); got != want {
		t.Fatalf("token drifted: got %q want %q", got, want)
	}
}

func TestVerifyRoundTrip(t *testing.T) {
	tok := Sign("11111111-1111-1111-1111-111111111111", secret)
	id, ok := Verify(tok, secret)
	if !ok || id != "11111111-1111-1111-1111-111111111111" {
		t.Fatalf("verify failed: ok=%v id=%q", ok, id)
	}
}

func TestVerifyRejectsTamperWrongSecretAndGarbage(t *testing.T) {
	tok := Sign("the-id", secret)
	if _, ok := Verify(tok+"x", secret); ok {
		t.Fatal("tampered token must not verify")
	}
	if _, ok := Verify(tok, "wrong-secret"); ok {
		t.Fatal("wrong secret must not verify")
	}
	for _, bad := range []string{"", "garbage", "a.b.c", "!!.sig"} {
		if _, ok := Verify(bad, secret); ok {
			t.Fatalf("%q must not verify", bad)
		}
	}
}

func TestAlertMonitorTokenRoundTrip(t *testing.T) {
	tok := AlertMonitorToken("mon-1", secret)
	id, ok := ParseAlertMonitorToken(tok, secret)
	if !ok || id != "mon-1" {
		t.Fatalf("parse failed: ok=%v id=%q", ok, id)
	}
}

func TestParseAlertMonitorTokenRejectsNewsletterToken(t *testing.T) {
	if _, ok := ParseAlertMonitorToken(Sign("sub-123", secret), secret); ok {
		t.Fatal("a newsletter token must not parse as an alert token")
	}
}

func TestParseAlertMonitorTokenRejectsMissingPrefixAndEmptyID(t *testing.T) {
	if _, ok := ParseAlertMonitorToken(Sign("mon-1", secret), secret); ok {
		t.Fatal("a token without the alert-monitor prefix must not parse")
	}
	if _, ok := ParseAlertMonitorToken(Sign("alert-monitor:", secret), secret); ok {
		t.Fatal("an empty monitor id must not parse")
	}
}

func TestParseAlertMonitorTokenRejectsWrongSecret(t *testing.T) {
	if _, ok := ParseAlertMonitorToken(AlertMonitorToken("mon-1", secret), "other"); ok {
		t.Fatal("wrong secret must not parse")
	}
}

func TestIsAlertID(t *testing.T) {
	if !IsAlertID("alert-monitor:mon-1") {
		t.Fatal("an alert token id must be recognised")
	}
	for _, id := range []string{"sub-123", "11111111-1111-1111-1111-111111111111", "alertless"} {
		if IsAlertID(id) {
			t.Fatalf("%q is not an alert id", id)
		}
	}
}
