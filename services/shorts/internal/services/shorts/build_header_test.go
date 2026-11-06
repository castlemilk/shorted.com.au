package shorts

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

// buildTestMux serves a 200, a Connect error and nothing else, behind the same
// wrapper Serve uses.
func buildTestMux(t *testing.T) http.Handler {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/ok", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("OK"))
	})
	handler := connect.NewUnaryHandler(
		"/test.v1.Thing/Fail",
		func(context.Context, *connect.Request[wrapperspb.StringValue]) (*connect.Response[wrapperspb.StringValue], error) {
			return nil, connect.NewError(connect.CodeNotFound, nil)
		},
	)
	mux.Handle("/test.v1.Thing/Fail", handler)
	return withBuildHeader(mux)
}

func TestBuildHeaderOnEveryResponse(t *testing.T) {
	t.Setenv("SERVICE_VERSION", "shorts-test-tag")
	h := buildTestMux(t)

	t.Run("200", func(t *testing.T) {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/ok", nil))
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "shorts-test-tag", rec.Header().Get(BuildHeader))
	})

	t.Run("404", func(t *testing.T) {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/nope", nil))
		require.Equal(t, http.StatusNotFound, rec.Code)
		assert.Equal(t, "shorts-test-tag", rec.Header().Get(BuildHeader))
	})

	t.Run("connect error", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/test.v1.Thing/Fail", strings.NewReader(`""`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Connect-Protocol-Version", "1")
		h.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
		assert.Equal(t, "shorts-test-tag", rec.Header().Get(BuildHeader))
	})
}

func TestBuildHeaderIsUnknownWhenUnset(t *testing.T) {
	t.Setenv("SERVICE_VERSION", "")
	rec := httptest.NewRecorder()
	buildTestMux(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/ok", nil))
	assert.Equal(t, "unknown", rec.Header().Get(BuildHeader))
}

func TestBuildHeaderIsExposedToBrowsers(t *testing.T) {
	cors := withCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Origin", "https://shorted.com.au")
	rec := httptest.NewRecorder()
	cors.ServeHTTP(rec, req)
	assert.Contains(t, rec.Header().Get("Access-Control-Expose-Headers"), BuildHeader)
}
