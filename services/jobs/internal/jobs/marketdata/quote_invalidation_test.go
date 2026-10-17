package marketdata

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	msync "github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/sync"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestInvalidateQuotesAfterSync(t *testing.T) {
	for _, tc := range []struct {
		name   string
		dryRun bool
		report *msync.RunReport
		want   int
	}{
		{"written", false, &msync.RunReport{Written: 10}, 1},
		{"partial written run", false, &msync.RunReport{Written: 10, Error: "run budget spent"}, 1},
		{"no writes", false, &msync.RunReport{}, 0},
		{"fetched without writes", false, &msync.RunReport{Fetched: 10}, 0},
		{"dry run", true, &msync.RunReport{Written: 10}, 0},
		{"failed before report", false, nil, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				assert.Equal(t, http.MethodPost, r.Method)
				assert.Equal(t, "quotes", r.URL.Query().Get("flush"))
				assert.Empty(t, r.URL.Query().Get("secret"))
				assert.Equal(t, "test-secret", r.Header.Get("X-Revalidate-Secret"))
				w.WriteHeader(http.StatusOK)
			}))
			defer server.Close()
			t.Setenv("REVALIDATION_URL", server.URL+"/api/revalidate")
			t.Setenv("REVALIDATION_SECRET", "test-secret")
			invalidateQuotesAfterSync(msync.RunOptions{DryRun: tc.dryRun}, tc.report)
			require.EqualValues(t, tc.want, requests.Load())
		})
	}
}

func TestQuoteInvalidationFailureDoesNotFailCompletedWrites(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()
	t.Setenv("REVALIDATION_URL", server.URL)
	t.Setenv("REVALIDATION_SECRET", "test-secret")
	require.NotPanics(t, func() {
		invalidateQuotesAfterSync(msync.RunOptions{}, &msync.RunReport{Written: 1})
	})
}
