package shorts 

import (
	"context"
	"net/http"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"

	shortsv1alpha1connect "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1/shortsv1alpha1connect"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"
)

func (s *ShortsServer) Serve(ctx context.Context, logger *log.Logger, address string) error {

	mux := http.NewServeMux()
	path, handler := shortsv1alpha1connect.NewShortedStocksServiceHandler(s)
	mux.Handle(path, handler)
	return http.ListenAndServe(
		address,
		// Use h2c so we can serve HTTP/2 without TLS.
		h2c.NewHandler(mux, &http2.Server{}),
	)
}
