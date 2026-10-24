// Package unsubscribe signs and verifies the HMAC tokens behind one-click email
// links: newsletter unsubscribe and alert pause. Both use UNSUBSCRIBE_SECRET.
//
// The domain separation between the two is a prefix on the signed id, not a
// second secret. A newsletter token carries a subscriber id and an alert token
// carries "alert-monitor:<monitor id>", so each endpoint refuses the other's
// token. Rotating UNSUBSCRIBE_SECRET invalidates both kinds of link at once.
package unsubscribe

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strings"
)

// alertMonitorPrefix marks the id of an alert monitor inside a signed token.
const alertMonitorPrefix = "alert-monitor:"

// alertIDPrefix is what every alert token's id starts with. The newsletter
// endpoint refuses any id carrying it.
const alertIDPrefix = "alert-"

// Sign returns the token for id under secret.
//
// Token format: base64url(id) + "." + base64url(hmac_sha256(id, secret)).
// Tokens have no expiry: they must keep working for at least 30 days, as AU
// Spam Act and CAN-SPAM require of an unsubscribe link.
func Sign(id, secret string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(id)) + "." + sign(id, secret)
}

// Verify returns the id a token was signed for, and false when the token is
// malformed, tampered with, or signed under another secret.
func Verify(token, secret string) (string, bool) {
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

// AlertMonitorToken returns the one-click pause token for an alert monitor.
func AlertMonitorToken(monitorID, secret string) string {
	return Sign(alertMonitorPrefix+monitorID, secret)
}

// ParseAlertMonitorToken returns the monitor id a token pauses. It requires the
// alert-monitor prefix, so a newsletter token never parses as an alert token.
func ParseAlertMonitorToken(token, secret string) (string, bool) {
	id, ok := Verify(token, secret)
	if !ok {
		return "", false
	}
	monitorID, found := strings.CutPrefix(id, alertMonitorPrefix)
	if !found || monitorID == "" {
		return "", false
	}
	return monitorID, true
}

// IsAlertID reports whether a verified token's id belongs to an alert. The
// newsletter unsubscribe endpoint refuses such ids, so an alert link cannot
// unsubscribe a newsletter address.
func IsAlertID(id string) bool {
	return strings.HasPrefix(id, alertIDPrefix)
}

func sign(id, secret string) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(id))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}
