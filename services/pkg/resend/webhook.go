package resend

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Resend delivers webhooks signed with Svix. The signing secret is "whsec_" plus
// base64 of the HMAC key. A signature covers "<svix-id>.<svix-timestamp>.<body>",
// and the svix-signature header holds one or more "v1,<base64 sig>" entries
// separated by spaces (more than one while a secret is rotated).

// WebhookTolerance is how far the svix-timestamp may sit from now. Svix's own
// reference verifier uses five minutes.
const WebhookTolerance = 5 * time.Minute

// ErrWebhookNotConfigured means no signing secret is set. The receiver must refuse
// every request rather than accept unsigned ones.
var ErrWebhookNotConfigured = errors.New("resend webhook secret not configured")

// ErrWebhookSecretInvalid means the configured secret is not a Svix secret.
var ErrWebhookSecretInvalid = errors.New("resend webhook secret is malformed")

// ErrWebhookSignature means the request is unsigned, stale, or signed with another key.
var ErrWebhookSignature = errors.New("resend webhook signature is invalid")

// VerifyWebhook checks a Resend (Svix) webhook. It returns nil only when the headers
// carry a current signature made with secret over body. now is injected for tests.
func VerifyWebhook(secret string, h http.Header, body []byte, now time.Time) error {
	if secret == "" {
		return ErrWebhookNotConfigured
	}
	key, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(secret, "whsec_"))
	if err != nil || len(key) == 0 {
		return ErrWebhookSecretInvalid
	}
	id := h.Get("svix-id")
	ts := h.Get("svix-timestamp")
	sigHeader := h.Get("svix-signature")
	if id == "" || ts == "" || sigHeader == "" {
		return ErrWebhookSignature
	}
	sec, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return ErrWebhookSignature
	}
	at := time.Unix(sec, 0)
	if at.Before(now.Add(-WebhookTolerance)) || at.After(now.Add(WebhookTolerance)) {
		return ErrWebhookSignature
	}

	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(id + "." + ts + "."))
	mac.Write(body)
	want := mac.Sum(nil)

	for _, entry := range strings.Fields(sigHeader) {
		version, sig, ok := strings.Cut(entry, ",")
		if !ok || version != "v1" {
			continue
		}
		got, err := base64.StdEncoding.DecodeString(sig)
		if err != nil {
			continue
		}
		if hmac.Equal(got, want) {
			return nil
		}
	}
	return ErrWebhookSignature
}

// WebhookEvent is the part of a Resend webhook this service acts on. Every other
// field is ignored, and no message body or bounce text is kept.
type WebhookEvent struct {
	Type       string   // for example "email.bounced" or "email.complained"
	EmailID    string   // the Resend email id, which alert_events.resend_id holds
	To         []string // the recipient addresses on that email
	BounceType string   // "Permanent" or "Transient" on email.bounced; empty otherwise
}

// ParseWebhookEvent reads the fields of a Resend webhook body. It rejects a body
// that is not JSON or has no type.
func ParseWebhookEvent(body []byte) (WebhookEvent, error) {
	var raw struct {
		Type string `json:"type"`
		Data struct {
			EmailID string   `json:"email_id"`
			To      []string `json:"to"`
			Bounce  *struct {
				Type string `json:"type"`
			} `json:"bounce"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return WebhookEvent{}, fmt.Errorf("resend webhook body is not JSON: %w", err)
	}
	if raw.Type == "" {
		return WebhookEvent{}, errors.New("resend webhook has no type")
	}
	ev := WebhookEvent{Type: raw.Type, EmailID: raw.Data.EmailID, To: raw.Data.To}
	if raw.Data.Bounce != nil {
		ev.BounceType = raw.Data.Bounce.Type
	}
	return ev, nil
}
