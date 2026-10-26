package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/pkg/ratelimit"
)

// memUsageStore is the usage store the AppLimiter writes through. The per-minute window is
// in process, so the store only needs to accept the monthly flushes.
type memUsageStore struct{}

func (memUsageStore) ApplyDeltas(context.Context, []ratelimit.UsageDelta) (map[ratelimit.UsageKey]int64, error) {
	return map[ratelimit.UsageKey]int64{}, nil
}
func (memUsageStore) Totals(context.Context, time.Time, []string) (map[ratelimit.UsageKey]int64, error) {
	return map[ratelimit.UsageKey]int64{}, nil
}

// meteredStack composes /mcp the way serve.go does: BatchGuard, then the rate limiter (with
// the real RateLimitCost and identity), then the handler. The anonymous per-minute allowance
// is perMinute. calls counts how many tools/call requests the server actually executed.
func meteredStack(t *testing.T, perMinute int, calls *atomic.Int64) http.Handler {
	t.Helper()
	cfg := ratelimit.DefaultConfig()
	cfg.Enabled = true
	anon := cfg.Tiers["anonymous"]
	anon.RequestsPerMinute = perMinute
	cfg.Tiers["anonymous"] = anon
	limiter := ratelimit.NewAppLimiter(cfg, memUsageStore{})
	t.Cleanup(func() { _ = limiter.Close() })

	counted := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(readAll(r), `"tools/call"`) {
			calls.Add(int64(strings.Count(readAll(r), `"tools/call"`)))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}`))
	})
	limited := ratelimit.NewHTTPMiddleware(limiter, cfg,
		RateLimitIdentity(nil),
		ratelimit.WithCost(RateLimitCost),
		ratelimit.WithRejection(RateLimitRejection(ProtectedResourceMetadataURL(conformanceOrigin))),
	)(counted)
	return BatchGuard(limited)
}

// readAll returns the request body without consuming it for the handler: the limiter and the
// guard both restore it, and this helper is only used inside the test server.
func readAll(r *http.Request) string {
	if r.Body == nil {
		return ""
	}
	raw := new(strings.Builder)
	buf := make([]byte, 4096)
	for {
		n, err := r.Body.Read(buf)
		raw.Write(buf[:n])
		if err != nil {
			break
		}
	}
	r.Body = readCloser{strings.NewReader(raw.String()), r.Body}
	return raw.String()
}

// Finding 4, the core claim: a batch is charged its real tool-call count, so a batch that
// costs more than the caller's remaining allowance is refused BEFORE a single call runs.
func TestAnOverBudgetBatchExecutesNoCall(t *testing.T) {
	var calls atomic.Int64
	h := meteredStack(t, 5, &calls)

	// Six calls against a five-per-minute allowance: the sixth unit is refused. The limiter
	// is checked one unit at a time before the handler runs, so none of the six reaches it.
	batch := batchOf(6)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, jsonRPCRequest(batch))
	// An anonymous caller at its ceiling gets the 401 challenge, not a 429 (rejectRateLimited).
	assert.Equal(t, http.StatusUnauthorized, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), `"kind":"per_minute"`)
	assert.Zero(t, calls.Load(), "a refused batch must not execute any call")
}

// The same batch within the allowance runs, and every call counts.
func TestAnAffordableBatchRunsAndCountsEveryCall(t *testing.T) {
	var calls atomic.Int64
	h := meteredStack(t, 20, &calls)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, jsonRPCRequest(batchOf(5)))
	assert.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, int64(5), calls.Load())
}

// A three-hundred-call batch is refused by the guard, outright, and charges nothing: the
// regression was that it ran in full for the price of 50.
func TestAThreeHundredCallBatchIsRefusedAndRunsNothing(t *testing.T) {
	var calls atomic.Int64
	h := meteredStack(t, 1000, &calls)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, jsonRPCRequest(batchOf(300)))
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Zero(t, calls.Load())
	var env struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env))
	assert.Contains(t, env.Error.Message, "300 tool calls")
}
