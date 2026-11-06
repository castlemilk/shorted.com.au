package shorts

import (
	"context"
	"io"
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
// chain Serve uses (rootHandler).
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
	return rootHandler(mux)
}

// serveWire runs the handler on a real socket and returns what the client
// received, not what the handler wrote into a recorder.
func serveWire(t *testing.T, h http.Handler, req *http.Request) *http.Response {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	req.URL.Scheme = "http"
	req.URL.Host = strings.TrimPrefix(srv.URL, "http://")
	req.RequestURI = ""
	resp, err := srv.Client().Do(req)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	})
	return resp
}

func TestBuildHeaderOnEveryResponse(t *testing.T) {
	t.Setenv("SERVICE_VERSION", "shorts-test-tag")
	h := buildTestMux(t)

	t.Run("200", func(t *testing.T) {
		req, _ := http.NewRequest(http.MethodGet, "/ok", nil)
		resp := serveWire(t, h, req)
		require.Equal(t, http.StatusOK, resp.StatusCode)
		assert.Equal(t, "shorts-test-tag", resp.Header.Get(BuildHeader))
	})

	t.Run("404", func(t *testing.T) {
		req, _ := http.NewRequest(http.MethodGet, "/nope", nil)
		resp := serveWire(t, h, req)
		require.Equal(t, http.StatusNotFound, resp.StatusCode)
		assert.Equal(t, "shorts-test-tag", resp.Header.Get(BuildHeader))
	})

	t.Run("connect error", func(t *testing.T) {
		req, _ := http.NewRequest(http.MethodPost, "/test.v1.Thing/Fail", strings.NewReader(`""`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Connect-Protocol-Version", "1")
		resp := serveWire(t, h, req)
		require.Equal(t, http.StatusNotFound, resp.StatusCode)
		assert.Equal(t, "shorts-test-tag", resp.Header.Get(BuildHeader))
	})
}

func TestBuildHeaderIsUnknownWhenUnset(t *testing.T) {
	t.Setenv("SERVICE_VERSION", "")
	req, _ := http.NewRequest(http.MethodGet, "/ok", nil)
	resp := serveWire(t, buildTestMux(t), req)
	assert.Equal(t, "unknown", resp.Header.Get(BuildHeader))
}

func TestBuildHeaderIsExposedToBrowsers(t *testing.T) {
	cors := withCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Origin", "https://shorted.com.au")
	rec := httptest.NewRecorder()
	cors.ServeHTTP(rec, req)
	assert.Contains(t, rec.Header().Get("Access-Control-Expose-Headers"), BuildHeader)
}

// TestServeWrapsEveryRouteInBuildHeader pins the production wiring: Serve must
// put rootHandler (which carries withBuildHeader) under h2c. A test chain alone
// cannot catch a later edit that drops the wrapper from Serve.
func TestServeWrapsEveryRouteInBuildHeader(t *testing.T) {
	serve := readRepoFile(t, "serve.go")
	assert.Contains(t, serve, "h2c.NewHandler(rootHandler(mux),")
	build := readRepoFile(t, "build_header.go")
	assert.Contains(t, build, "return withBuildHeader(shortedotel.HTTPMiddleware(mux))")
}
