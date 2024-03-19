package shorts 

import (
	"context"

	shortsv1alpha1connect "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1/shortsv1alpha1connect"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// ShortsServer ...
type ShortsServer struct {
	config Config
	store  shorts.Store
	shortsv1alpha1connect.UnimplementedShortedStocksServiceHandler
}

// New creates instance of the Server
func New(ctx context.Context, cfg Config) (*ShortsServer, error) {

	return &ShortsServer{
		config: cfg,
		store:  shorts.NewStore(cfg.ShortsStoreConfig),
	}, nil
}
