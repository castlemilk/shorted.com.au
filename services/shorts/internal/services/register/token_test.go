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
