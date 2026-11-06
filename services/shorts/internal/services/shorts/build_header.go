package shorts

import (
	"net/http"
	"os"
)

// BuildHeader names the response header that carries the build the API is
// running. The value is SERVICE_VERSION (the image tag on Cloud Run), or
// "unknown" when it is unset. A response without it came from something in
// front of the API (Envoy, Cloudflare), so the edge worker and the deploy's
// checks use it to tell the app's answers from the platform's.
const BuildHeader = "X-Shorted-Build"

// buildUnknown is the value of BuildHeader when SERVICE_VERSION is unset.
const buildUnknown = "unknown"

// withBuildHeader sets BuildHeader on every response the wrapped handler
// writes. It is applied outermost, around the whole mux, so no route, error
// reply or middleware underneath can skip it.
func withBuildHeader(next http.Handler) http.Handler {
	build := os.Getenv("SERVICE_VERSION")
	if build == "" {
		build = buildUnknown
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(BuildHeader, build)
		next.ServeHTTP(w, r)
	})
}
