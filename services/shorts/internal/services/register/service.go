package register

import (
	"context"
	"errors"

	"connectrpc.com/connect"
	valid "github.com/asaskevich/govalidator"
	registerv1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/register/v1"
	registerv1connect "github.com/castlemilk/shorted.com.au/services/gen/proto/go/register/v1/registerv1connect"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
)

// validate ServerServer implements productpb.ServerService
var _ registerv1connect.RegisterServiceHandler = (*RegisterServer)(nil)

func (s *RegisterServer) RegisterEmail(ctx context.Context, req *connect.Request[registerv1.RegisterEmailRequest]) (*connect.Response[registerv1.RegisterEmailResponse], error) {
	log.Debugf("register email, email: %s", req.Msg.Email)
	// validate email
	if !valid.IsEmail(req.Msg.Email) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid email"))
	}
	err := s.store.RegisterEmail(req.Msg.Email)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&registerv1.RegisterEmailResponse{
		Success: true,
	}), nil
}
