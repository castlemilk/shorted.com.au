package resend

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"testing"
	"time"
)

// testKey is the raw HMAC key; testSecret is the "whsec_" form Resend shows.
var testKey = []byte("0123456789abcdef0123456789abcdef")
var testSecret = "whsec_" + base64.StdEncoding.EncodeToString(testKey)

// sign computes a Svix v1 signature independently of VerifyWebhook, so the test
// does not check the code against itself.
func sign(key []byte, id, ts string, body []byte) string {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(id + "." + ts + "."))
	m.Write(body)
	return "v1," + base64.StdEncoding.EncodeToString(m.Sum(nil))
}

func headers(id, ts, sig string) http.Header {
	h := http.Header{}
	if id != "" {
		h.Set("svix-id", id)
	}
	if ts != "" {
		h.Set("svix-timestamp", ts)
	}
	if sig != "" {
		h.Set("svix-signature", sig)
	}
	return h
}

var body = []byte(`{"type":"email.bounced","data":{"email_id":"em_1","to":["a@example.com"]}}`)

func TestVerifyWebhook(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	ts := strconv.FormatInt(now.Unix(), 10)
	good := sign(testKey, "msg_1", ts, body)

	cases := []struct {
		name    string
		secret  string
		h       http.Header
		body    []byte
		now     time.Time
		wantErr error
	}{
		{"valid signature", testSecret, headers("msg_1", ts, good), body, now, nil},
		{"valid when one of several signatures matches (rotation)", testSecret,
			headers("msg_1", ts, "v1,AAAA "+good), body, now, nil},
		{"wrong key", testSecret,
			headers("msg_1", ts, sign([]byte("another-key-another-key-xxxxxxx"), "msg_1", ts, body)), body, now, ErrWebhookSignature},
		{"tampered body", testSecret, headers("msg_1", ts, good),
			[]byte(`{"type":"email.bounced","data":{"email_id":"em_2","to":["a@example.com"]}}`), now, ErrWebhookSignature},
		{"changed message id", testSecret, headers("msg_2", ts, good), body, now, ErrWebhookSignature},
		{"missing signature header", testSecret, headers("msg_1", ts, ""), body, now, ErrWebhookSignature},
		{"missing timestamp", testSecret, headers("msg_1", "", good), body, now, ErrWebhookSignature},
		{"missing id", testSecret, headers("", ts, good), body, now, ErrWebhookSignature},
		{"no headers at all", testSecret, http.Header{}, body, now, ErrWebhookSignature},
		{"timestamp not a number", testSecret, headers("msg_1", "yesterday", good), body, now, ErrWebhookSignature},
		{"timestamp too old (replay)", testSecret, headers("msg_1", ts, good), body, now.Add(WebhookTolerance + time.Second), ErrWebhookSignature},
		{"timestamp too far in the future", testSecret, headers("msg_1", ts, good), body, now.Add(-WebhookTolerance - time.Second), ErrWebhookSignature},
		{"no version prefix", testSecret, headers("msg_1", ts, good[len("v1,"):]), body, now, ErrWebhookSignature},
		{"secret not configured", "", headers("msg_1", ts, good), body, now, ErrWebhookNotConfigured},
		{"secret is not base64", "whsec_!!!not base64", headers("msg_1", ts, good), body, now, ErrWebhookSecretInvalid},
		{"secret decodes to nothing", "whsec_", headers("msg_1", ts, good), body, now, ErrWebhookSecretInvalid},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := VerifyWebhook(tc.secret, tc.h, tc.body, tc.now)
			if !errors.Is(err, tc.wantErr) && !(tc.wantErr == nil && err == nil) {
				t.Fatalf("VerifyWebhook() = %v, want %v", err, tc.wantErr)
			}
		})
	}
}

func TestVerifyWebhookAcceptsSecretWithoutPrefix(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	ts := strconv.FormatInt(now.Unix(), 10)
	raw := base64.StdEncoding.EncodeToString(testKey)
	if err := VerifyWebhook(raw, headers("msg_1", ts, sign(testKey, "msg_1", ts, body)), body, now); err != nil {
		t.Fatalf("a bare base64 key should verify, got %v", err)
	}
}

func TestParseWebhookEvent(t *testing.T) {
	ev, err := ParseWebhookEvent([]byte(`{"type":"email.bounced","created_at":"x","data":{"email_id":"em_9","to":["Ops@Example.com"],"bounce":{"type":"Permanent","message":"no such user"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if ev.Type != "email.bounced" || ev.EmailID != "em_9" || ev.BounceType != "Permanent" || len(ev.To) != 1 || ev.To[0] != "Ops@Example.com" {
		t.Fatalf("parsed %+v", ev)
	}

	ev, err = ParseWebhookEvent([]byte(`{"type":"email.complained","data":{"email_id":"em_10","to":["b@example.com"]}}`))
	if err != nil {
		t.Fatal(err)
	}
	if ev.Type != "email.complained" || ev.BounceType != "" {
		t.Fatalf("complaint parsed as %+v", ev)
	}

	if _, err := ParseWebhookEvent([]byte(`not json`)); err == nil {
		t.Fatal("a body that is not JSON must be rejected")
	}
	if _, err := ParseWebhookEvent([]byte(`{"data":{}}`)); err == nil {
		t.Fatal("a body with no type must be rejected")
	}
}

// Mutation check: the verifier must not accept a signature without the key.
func TestVerifyWebhookRejectsUnsignedBodyEvenWithMatchingHeaders(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	ts := fmt.Sprint(now.Unix())
	h := headers("msg_1", ts, "v1,"+base64.StdEncoding.EncodeToString(sha256.New().Sum(nil)))
	if err := VerifyWebhook(testSecret, h, body, now); !errors.Is(err, ErrWebhookSignature) {
		t.Fatalf("a bare digest must not verify, got %v", err)
	}
}
