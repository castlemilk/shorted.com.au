package shorts

// adapters_resend_webhook.go forwards the Resend feedback write through StoreAdapter.
//
// The webhook reaches its store by type assertion (resendWebhookStoreFrom). serve.go
// passes the adapter, not the Postgres store under it, so without this forwarder the
// assertion yields nil and /webhooks/resend answers "store not configured" with every
// secret in place. TestResendWebhookStoreReachableThroughTheAdapter pins this.

import (
	"context"
	"fmt"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// RecordResendFeedback forwards to the underlying store, or names the gap when the
// backend does not record Resend feedback.
func (s *StoreAdapter) RecordResendFeedback(ctx context.Context, emailID, status, reason string, addresses []string) (shorts.ResendFeedbackResult, error) {
	w, ok := s.store.(ResendWebhookStore)
	if !ok {
		return shorts.ResendFeedbackResult{}, fmt.Errorf("the store backend (%T) does not record Resend feedback", s.store)
	}
	return w.RecordResendFeedback(ctx, emailID, status, reason, addresses)
}
