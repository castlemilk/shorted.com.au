package shorts

// resend_webhook.go: POST /webhooks/resend. Resend reports what happened to an
// email after it was accepted. A permanent bounce or a complaint marks the alert
// delivery and suppresses the address (see store RecordResendFeedback); every other
// event is acknowledged and ignored. Signature checks come first, so nothing else
// reads the body of an unsigned request.
//
// The endpoint is inert until RESEND_WEBHOOK_SECRET is set: every request gets 503,
// and no other route is affected. Create the endpoint in Resend and store its
// signing secret with `cuttle secrets set RESEND_WEBHOOK_SECRET --project shorted`.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/resend"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// ResendWebhookPath is where Resend posts events.
const ResendWebhookPath = "/webhooks/resend"

// resendWebhookBodyLimit caps the body. A Resend event is a few hundred bytes.
const resendWebhookBodyLimit = 1 << 20

// ResendWebhookStore is the store the webhook writes through. Reached by a type
// assertion on ShortsStore, so the shared interface and its mocks are unchanged.
type ResendWebhookStore interface {
	RecordResendFeedback(ctx context.Context, emailID, status, reason string, addresses []string) (shortsstore.ResendFeedbackResult, error)
}

// resendWebhookStoreFrom narrows the server's store. Nil when the store does not
// provide the feedback writes, and the handler then answers 503.
func resendWebhookStoreFrom(s ShortsStore) ResendWebhookStore {
	w, _ := s.(ResendWebhookStore)
	return w
}

// ResendWebhookConfig wires the handler. Notify sends the operator notice; nil means
// the notice is only logged. Infof and Errorf receive event summaries; they never
// carry a message body, and addresses appear only in the operator notice.
type ResendWebhookConfig struct {
	Secret string
	Store  ResendWebhookStore
	Notify func(ctx context.Context, subject, text string) error
	Infof  func(format string, args ...any)
	Errorf func(format string, args ...any)
	Now    func() time.Time
}

// NewResendWebhookHandler returns the Resend webhook receiver.
func NewResendWebhookHandler(cfg ResendWebhookConfig) http.Handler {
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	infof, errorf := cfg.Infof, cfg.Errorf
	if infof == nil {
		infof = log.Printf
	}
	if errorf == nil {
		errorf = log.Printf
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if cfg.Store == nil {
			http.Error(w, "resend webhook store not configured", http.StatusServiceUnavailable)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, resendWebhookBodyLimit+1))
		if err != nil || len(body) > resendWebhookBodyLimit {
			http.Error(w, "body unreadable or too large", http.StatusBadRequest)
			return
		}

		switch err := resend.VerifyWebhook(cfg.Secret, r.Header, body, now()); {
		case errors.Is(err, resend.ErrWebhookNotConfigured):
			http.Error(w, "resend webhook not configured", http.StatusServiceUnavailable)
			return
		case errors.Is(err, resend.ErrWebhookSecretInvalid):
			errorf("resend webhook: RESEND_WEBHOOK_SECRET is not a Svix secret; every event is refused")
			http.Error(w, "resend webhook not configured", http.StatusServiceUnavailable)
			return
		case err != nil:
			http.Error(w, "signature verification failed", http.StatusUnauthorized)
			return
		}

		ev, err := resend.ParseWebhookEvent(body)
		if err != nil {
			http.Error(w, "malformed event", http.StatusBadRequest)
			return
		}

		status, reason, act := feedbackFor(ev)
		if !act {
			writeJSON(w, map[string]any{"handled": false, "event": ev.Type})
			return
		}

		res, err := cfg.Store.RecordResendFeedback(r.Context(), ev.EmailID, status, reason, ev.To)
		if err != nil {
			// A 500 makes Resend retry the event, which is safe: the write is idempotent.
			errorf("resend webhook: record %s for email %s failed: %v", ev.Type, ev.EmailID, err)
			http.Error(w, "could not record feedback", http.StatusInternalServerError)
			return
		}
		infof("resend webhook: %s email=%s deliveries=%d suppressed=%d", ev.Type, ev.EmailID, res.Deliveries, len(res.NewlySuppressed))

		if len(res.NewlySuppressed) > 0 && cfg.Notify != nil {
			subject, text := operatorNotice(ev, status, res)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			if err := cfg.Notify(ctx, subject, text); err != nil {
				// The feedback is recorded; a failed notice is logged, not retried.
				errorf("resend webhook: operator notice failed: %v", err)
			}
			cancel()
		}
		writeJSON(w, map[string]any{"handled": true, "deliveries": res.Deliveries, "suppressed": len(res.NewlySuppressed)})
	})
}

// feedbackFor maps an event to the delivery status and suppression reason it
// produces. Only a permanent bounce suppresses: a transient or undetermined bounce
// is an inbox that was full or unreachable, and the address is not blocked for it.
func feedbackFor(ev resend.WebhookEvent) (status, reason string, act bool) {
	switch ev.Type {
	case "email.bounced":
		if ev.BounceType != "Permanent" {
			return "", "", false
		}
		return "bounced", "bounced", true
	case "email.complained":
		return "complained", "complained", true
	}
	return "", "", false
}

// operatorNotice is the email that tells the owner an address was suppressed. It
// names the address, which the operator needs in order to act on it.
func operatorNotice(ev resend.WebhookEvent, status string, res shortsstore.ResendFeedbackResult) (string, string) {
	what := "hard bounced"
	if status == "complained" {
		what = "marked an alert email as spam"
	}
	subject := fmt.Sprintf("Alert email suppressed: %s", status)
	var b strings.Builder
	for _, a := range res.NewlySuppressed {
		fmt.Fprintf(&b, "%s %s. Alert emails to it are now suppressed.\n", a, what)
	}
	fmt.Fprintf(&b, "\nResend email id: %s\nAlert deliveries marked %s: %d\n", ev.EmailID, status, res.Deliveries)
	fmt.Fprintf(&b, "\nThe address stays suppressed until a row is removed from alert_email_suppressions.\n")
	return subject, b.String()
}

// ResendOperatorNotifier returns the Notify function for the webhook: one email to
// the operator through Resend. It is nil when the key or the recipient is unset, so
// the feedback is still recorded and the notice is logged instead.
func ResendOperatorNotifier(apiKey, from, to string) func(ctx context.Context, subject, text string) error {
	if apiKey == "" || to == "" {
		return nil
	}
	client := &resend.Client{APIKey: apiKey}
	return func(ctx context.Context, subject, text string) error {
		// The key is the notice's content hash, so a replayed notice is not sent twice.
		sum := sha256.Sum256([]byte(subject + "\n" + text))
		_, err := client.Send(ctx, resend.Email{
			From:    from,
			To:      []string{to},
			Subject: subject,
			Text:    text,
			HTML:    "<pre style=\"font-family:monospace;white-space:pre-wrap\">" + html.EscapeString(text) + "</pre>",
		}, "feedback-notice-"+hex.EncodeToString(sum[:12]))
		return err
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
