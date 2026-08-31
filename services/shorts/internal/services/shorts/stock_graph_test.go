package shorts

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

func TestGetStockGraph_HandlerReturnsPeopleAndPeers(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().
		GetStockGraph("BHP", int32(12)).
		Return(&shortsstore.StockGraphResult{
			People: []*shortsstore.GraphPersonRow{
				{
					Name:        "Jane Smith",
					Role:        "Director",
					ImageURL:    "https://example.com/jane.jpg",
					LinkedInURL: "https://linkedin.com/in/janesmith",
					AlsoAt:      []string{"RIO", "FMG"},
				},
			},
			SimilarCompanies: []*shortsstore.GraphPeerRow{
				{
					StockCode:   "RIO",
					CompanyName: "Rio Tinto Limited",
					Industry:    "Materials",
					Similarity:  0.92,
				},
			},
		}, nil)

	srv := newTestServer(t, mockStore)
	// Lowercase input proves the handler normalizes before hitting the store
	// (the mock above expects "BHP").
	resp, err := srv.GetStockGraph(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockGraphRequest{
		StockCode: "bhp",
		Limit:     12,
	}))

	require.NoError(t, err)
	require.Len(t, resp.Msg.People, 1)
	assert.Equal(t, "Jane Smith", resp.Msg.People[0].Name)
	assert.Equal(t, "Director", resp.Msg.People[0].Role)
	assert.Equal(t, []string{"RIO", "FMG"}, resp.Msg.People[0].AlsoAt)

	require.Len(t, resp.Msg.SimilarCompanies, 1)
	assert.Equal(t, "RIO", resp.Msg.SimilarCompanies[0].StockCode)
	assert.Equal(t, "Rio Tinto Limited", resp.Msg.SimilarCompanies[0].CompanyName)
	assert.InDelta(t, 0.92, resp.Msg.SimilarCompanies[0].Similarity, 0.001)
}

func TestGetStockGraph_HandlerRejectsEmptyStockCode(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))
	_, err := srv.GetStockGraph(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockGraphRequest{}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

func TestGetStockGraph_HandlerEmptySimilarCompanies(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().
		GetStockGraph("CBA", int32(12)).
		Return(&shortsstore.StockGraphResult{
			People: []*shortsstore.GraphPersonRow{
				{Name: "Matt Comyn", Role: "CEO", AlsoAt: []string{}},
			},
			// No similar_to edges yet — this is normal before backfill
			SimilarCompanies: nil,
		}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetStockGraph(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockGraphRequest{
		StockCode: "CBA",
	}))

	require.NoError(t, err)
	require.Len(t, resp.Msg.People, 1)
	assert.Empty(t, resp.Msg.SimilarCompanies)
}
