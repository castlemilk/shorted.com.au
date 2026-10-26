package register

import "testing"

func TestUnsubscribeTokenRoundTrip(t *testing.T) {
	secret := "test-secret-key"
	id := "11111111-1111-1111-1111-111111111111"
	tok := SignUnsubscribeToken(id, secret)
	if tok == "" {
		t.Fatal("expected non-empty token")
	}
	gotID, ok := VerifyUnsubscribeToken(tok, secret)
	if !ok || gotID != id {
		t.Fatalf("verify failed: ok=%v id=%q want %q", ok, gotID, id)
	}
}

func TestUnsubscribeTokenTamperRejected(t *testing.T) {
	secret := "test-secret-key"
	tok := SignUnsubscribeToken("the-id", secret)
	if _, ok := VerifyUnsubscribeToken(tok+"x", secret); ok {
		t.Fatal("tampered token must not verify")
	}
	if _, ok := VerifyUnsubscribeToken(tok, "wrong-secret"); ok {
		t.Fatal("wrong secret must not verify")
	}
	if _, ok := VerifyUnsubscribeToken("garbage", secret); ok {
		t.Fatal("garbage must not verify")
	}
}

// TestUnsubscribeTokenGoldenVector pins the wire format of a newsletter token.
// Links already sent in broadcasts carry this shape, so it must not change when
// the signing code moves to services/pkg/unsubscribe.
func TestUnsubscribeTokenGoldenVector(t *testing.T) {
	const want = "c3ViLTEyMw.kd23woUzqLIEeZDOdSd45JX5ngOjmNL0lZ4mR0TfnQk"
	if got := SignUnsubscribeToken("sub-123", "test-secret"); got != want {
		t.Fatalf("token drifted: got %q want %q", got, want)
	}
}
