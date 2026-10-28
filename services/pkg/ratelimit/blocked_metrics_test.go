package ratelimit

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

func TestBlockedMetricsBoundTierWithoutChangingQuotaResponse(t *testing.T) {
	for _, transport := range []string{"http", "connect"} {
		t.Run(transport, func(t *testing.T) {
			reader := installMetrics(t)
			for _, tier := range []string{"free", "private-tier-1", "private-tier-2"} {
				limiter := &countingLimiter{allow: 0}
				if transport == "http" {
					handler := NewHTTPMiddleware(limiter, enabledConfig(), func(*http.Request) Caller {
						return Caller{Identifier: "test:caller", Tier: tier}
					})(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
						t.Fatal("blocked request reached handler")
					}))
					response := do(handler, request())
					require.Equal(t, http.StatusTooManyRequests, response.Code)
					require.Equal(t, tier, response.Header().Get(headerTier), "quota response retains original tier")
				} else {
					interceptor := NewRateLimitInterceptor(limiter, enabledConfig(), DefaultUserClaimsKey)
					next := interceptor(func(context.Context, connect.AnyRequest) (connect.AnyResponse, error) {
						t.Fatal("blocked request reached handler")
						return nil, nil
					})
					ctx := context.WithValue(context.Background(), DefaultUserClaimsKey, testClaims{id: "caller", tier: tier})
					_, err := next(ctx, connect.NewRequest(new(string)))
					var rejection *connect.Error
					require.True(t, errors.As(err, &rejection))
					require.Equal(t, connect.CodeResourceExhausted, rejection.Code())
					require.Equal(t, tier, rejection.Meta().Get(headerTier), "quota response retains original tier")
				}
				require.Equal(t, tier, limiter.tier.Load(), "limiter still evaluates original tier")
			}
			metrics := collect(t, reader)
			const name = "shorted.rate_limit.blocked"
			sum := findMetric(t, metrics, name).Data.(metricdata.Sum[int64])
			require.Len(t, sum.DataPoints, 2, "unknown tiers aggregate before export")
			require.Equal(t, int64(1), counterFor(t, metrics, name, "tier=free", "kind=per_minute"))
			require.Equal(t, int64(2), counterFor(t, metrics, name, "tier=other", "kind=per_minute"))
		})
	}
}
