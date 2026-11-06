package shorts

import (
	"context"
	"errors"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

// keyMetricsRetiredMessage is what SyncKeyMetrics says now. The RPC stays in
// the protos (public surface, append-only) and answers with this error.
const keyMetricsRetiredMessage = "key metrics are refreshed by the daily key-metrics job"

// SyncKeyMetrics is retired. It used to fork python3 and yfinance once per stock
// inside this process; that never finished (the instance was killed for memory
// shortly after each scheduler trigger), so the refresh moved to the
// `shorted key-metrics` job on VKE (services/jobs/internal/jobs/keymetrics).
// The handler has no side effects: it neither reads nor writes the database.
func (s *ShortsServer) SyncKeyMetrics(
	_ context.Context,
	_ *connect.Request[shortsv1alpha1.SyncKeyMetricsRequest],
) (*connect.Response[shortsv1alpha1.SyncKeyMetricsResponse], error) {
	return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New(keyMetricsRetiredMessage))
}
