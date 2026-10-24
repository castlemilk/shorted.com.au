package register

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	registerv1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/register/v1"
	"github.com/castlemilk/shorted.com.au/services/pkg/unsubscribe"
)

// An alert pause token must not unsubscribe a newsletter address. The store is
// nil on purpose: the guard refuses before any store call.
func TestUnsubscribeRefusesAlertToken(t *testing.T) {
	const secret = "test-secret"
	s := &RegisterServer{unsubscribeSecret: secret}
	tok := unsubscribe.AlertMonitorToken("mon-1", secret)

	_, err := s.Unsubscribe(context.Background(), connect.NewRequest(&registerv1.UnsubscribeRequest{Token: tok}))
	if err == nil {
		t.Fatal("an alert token must be refused by the newsletter endpoint")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("code = %v, want InvalidArgument", connect.CodeOf(err))
	}
}
