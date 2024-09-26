package shorts

import (
	"context"
	"fmt"
	"net/http"

	connectcors "connectrpc.com/cors"
	"github.com/rs/cors"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"

	"github.com/castlemilk/shorted.com.au/services/gen/proto/go/register/v1/registerv1connect"
	shortsv1alpha1connect "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1/shortsv1alpha1connect"
	"github.com/rakyll/statik/fs"

	_ "github.com/castlemilk/shorted.com.au/services/shorts/internal/api/schema/statik"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"
)

// withCORS adds CORS support to a Connect HTTP handler.
func withCORS(h http.Handler) http.Handler {
	middleware := cors.New(cors.Options{
		AllowedOrigins:   []string{"http://localhost:3000", "http://localhost:3001", "https://*.vercel.app", "https://*.shorted.com.au", "https://shorted.com.au"},
		AllowedMethods:   connectcors.AllowedMethods(),
		AllowedHeaders:   append([]string{"Authorization"}, connectcors.AllowedHeaders()...),
		ExposedHeaders:   connectcors.ExposedHeaders(),
	})
	return middleware.Handler(h)
}

func (s *ShortsServer) Serve(ctx context.Context, logger *log.Logger, address string) error {

	mux := http.NewServeMux()
	shortsPath, shortsHandler := shortsv1alpha1connect.NewShortedStocksServiceHandler(s)
	registerPath, registerHandler := registerv1connect.NewRegisterServiceHandler(s.registerServer)
	shortsHandler = withCORS(shortsHandler)
	registerHandler = withCORS(registerHandler)
	// handler = AuthMiddleware(handler)
	mux.Handle(shortsPath, shortsHandler)
	mux.Handle(registerPath, registerHandler)

	// Add statik file server
	statikFS, err := fs.New()
	if err != nil {
		return fmt.Errorf("failed to create statik filesystem: %w", err)
	}
	mux.Handle("/api/docs/", withCORS(http.StripPrefix("/api/docs/", http.FileServer(statikFS))))

	return http.ListenAndServe(
		address,
		// Use h2c so we can serve HTTP/2 without TLS.
		h2c.NewHandler(mux, &http2.Server{}),
	)
}
