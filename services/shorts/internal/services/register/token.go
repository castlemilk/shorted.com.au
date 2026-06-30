package register

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strings"
)

// Token format: base64url(id) + "." + base64url(hmac_sha256(id, secret)).
// Long-lived (no expiry) — must work >=30 days per AU Spam Act / CAN-SPAM.
func sign(id, secret string) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(id))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func SignUnsubscribeToken(id, secret string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(id)) + "." + sign(id, secret)
}

func VerifyUnsubscribeToken(token, secret string) (string, bool) {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		return "", false
	}
	idBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", false
	}
	id := string(idBytes)
	expected := sign(id, secret)
	if !hmac.Equal([]byte(expected), []byte(parts[1])) {
		return "", false
	}
	return id, true
}
