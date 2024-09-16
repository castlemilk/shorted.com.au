package register

import (
	registerv1connect "github.com/castlemilk/shorted.com.au/services/gen/proto/go/register/v1/registerv1connect"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// RegisterServer implements the RegisterServiceServer interface
type RegisterServer struct {
    registerv1connect.UnimplementedRegisterServiceHandler
	store  shorts.Store
}

func NewRegisterServer(cfg shorts.Config) *RegisterServer {
    return &RegisterServer{
		store:  shorts.NewStore(cfg),
    }
}