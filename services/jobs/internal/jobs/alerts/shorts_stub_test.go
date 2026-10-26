package alerts

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsv1alpha1connect "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1/shortsv1alpha1connect"
	"github.com/castlemilk/shorted.com.au/services/pkg/unsubscribe"
)

// stubAlerts answers the one AlertsService call the job makes: the canary's pause
// round trip. The stub holds no monitors, so a token the secret verifies names
// nothing and is NotFound, as the API answers for an unknown monitor. A token the
// secret does not verify is InvalidArgument, which is what a stale secret gets.
type stubAlerts struct {
	shortsv1alpha1connect.UnimplementedAlertsServiceHandler
	secret string
}

func (s stubAlerts) PauseAlertMonitorByToken(_ context.Context, req *connect.Request[shortsv1alpha1.PauseAlertMonitorByTokenRequest]) (*connect.Response[shortsv1alpha1.PauseAlertMonitorByTokenResponse], error) {
	if _, ok := unsubscribe.ParseAlertMonitorToken(req.Msg.Token, s.secret); !ok {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid token"))
	}
	return nil, connect.NewError(connect.CodeNotFound, errors.New("alert monitor not found"))
}

// startShortsAPI serves the two shorts API services the job calls over one origin:
// BillingService for entitlement and AlertsService for the pause round trip. The
// unsubscribe secret is the one the stub verifies tokens with.
func startShortsAPI(t *testing.T, billing *stubBilling, unsubSecret string) string {
	t.Helper()
	bp, bh := shortsv1alpha1connect.NewBillingServiceHandler(billing)
	ap, ah := shortsv1alpha1connect.NewAlertsServiceHandler(stubAlerts{secret: unsubSecret})
	mux := http.NewServeMux()
	mux.Handle(bp, bh)
	mux.Handle(ap, ah)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv.URL
}
