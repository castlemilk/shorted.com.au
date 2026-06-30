package register

import (
	"fmt"
	"os"

	registerv1connect "github.com/castlemilk/shorted.com.au/services/gen/proto/go/register/v1/registerv1connect"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// RegisterServer implements the RegisterServiceServer interface
type RegisterServer struct {
	registerv1connect.UnimplementedRegisterServiceHandler
	store             shorts.Store
	unsubscribeSecret string
}

func NewRegisterServer(cfg shorts.Config) (*RegisterServer, error) {
	store, err := shorts.NewStore(cfg)
	if err != nil {
		return nil, fmt.Errorf("failed to create register store: %w", err)
	}
	return &RegisterServer{
		store:             store,
		unsubscribeSecret: os.Getenv("UNSUBSCRIBE_SECRET"),
	}, nil
}
