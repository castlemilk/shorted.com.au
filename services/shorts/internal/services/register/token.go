package register

import (
	"github.com/castlemilk/shorted.com.au/services/pkg/unsubscribe"
)

// SignUnsubscribeToken signs a newsletter subscriber id. The broadcast sender is
// injected with it, so it must keep this signature. The format lives in
// services/pkg/unsubscribe, shared with alert pause links.
func SignUnsubscribeToken(id, secret string) string {
	return unsubscribe.Sign(id, secret)
}

// VerifyUnsubscribeToken returns the id a newsletter token was signed for.
func VerifyUnsubscribeToken(token, secret string) (string, bool) {
	return unsubscribe.Verify(token, secret)
}
