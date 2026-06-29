package shorts

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
)

func TestListStateSuburbs_RequiresState(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))
	_, err := srv.ListStateSuburbs(context.Background(),
		connect.NewRequest(&shortsv1alpha1.ListStateSuburbsRequest{StateCode: ""}))
	if err == nil || connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("want InvalidArgument, got %v", err)
	}
}
