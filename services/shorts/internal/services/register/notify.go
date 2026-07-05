package register

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
)

// resendEndpoint is the Resend transactional email API.
const resendEndpoint = "https://api.resend.com/emails"

// notifyNewSubscriber sends a best-effort operator notification email (via
// Resend) when a new newsletter subscriber registers.
//
// It is intentionally:
//   - a no-op when RESEND_API_KEY is unset (so it ships safely dormant until the
//     secret is provisioned);
//   - non-fatal — any failure is logged and the subscribe still succeeds;
//   - synchronous with a short timeout — Cloud Run only allocates CPU during a
//     request, so a detached goroutine after the response may never run; we send
//     inline (a few hundred ms) to guarantee the attempt completes.
func notifyNewSubscriber(email string) {
	apiKey := os.Getenv("RESEND_API_KEY")
	if apiKey == "" {
		return // notifications not configured — dormant
	}
	from := os.Getenv("RESEND_FROM")
	if from == "" {
		from = "Shorted <notifications@shorted.com.au>"
	}
	to := os.Getenv("RESEND_TO")
	if to == "" {
		to = "ben.ebsworth@gmail.com"
	}

	payload := map[string]any{
		"from":    from,
		"to":      []string{to},
		"subject": "New newsletter subscriber: " + email,
		"text":    "A new visitor subscribed to the Shorted newsletter:\n\n" + email + "\n\n— shorted.com.au",
	}
	body, err := json.Marshal(payload)
	if err != nil {
		log.Warnf("notifyNewSubscriber: marshal failed: %v", err)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, resendEndpoint, bytes.NewReader(body))
	if err != nil {
		log.Warnf("notifyNewSubscriber: build request failed: %v", err)
		return
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		log.Warnf("notifyNewSubscriber: resend POST failed for %s: %v", email, err)
		return
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 {
		log.Warnf("notifyNewSubscriber: resend returned status %d for %s", resp.StatusCode, email)
		return
	}
	log.Infof("notifyNewSubscriber: operator notified of new subscriber %s", email)
}
