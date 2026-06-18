package shorts

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
)

func newTestServer(t *testing.T, store ShortsStore) *ShortsServer {
	t.Helper()
	ctrl := gomock.NewController(t)
	mockLogger := mocks.NewMockLogger(ctrl)
	mockLogger.EXPECT().Debugf(gomock.Any(), gomock.Any()).AnyTimes()
	mockLogger.EXPECT().Errorf(gomock.Any(), gomock.Any()).AnyTimes()
	return &ShortsServer{
		store:  store,
		cache:  NewMemoryCache(time.Minute),
		logger: mockLogger,
	}
}

func TestGetRelatedNews_HandlerReturnsArticles(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().
		GetRelatedNews("BHP", "", int32(6)).
		Return([]*shortsstore.NewsArticle{
			{ID: "a1", StockCode: "BHP", Source: "stockhead", Headline: "Related one", URL: "http://x/1"},
		}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetRelatedNews(context.Background(), connect.NewRequest(&shortsv1alpha1.GetRelatedNewsRequest{
		StockCode: "BHP",
		Limit:     6,
	}))

	require.NoError(t, err)
	require.Len(t, resp.Msg.Articles, 1)
	assert.Equal(t, "Related one", resp.Msg.Articles[0].Headline)
}

func TestGetRelatedNews_HandlerRejectsEmptyStock(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))
	_, err := srv.GetRelatedNews(context.Background(), connect.NewRequest(&shortsv1alpha1.GetRelatedNewsRequest{}))
	require.Error(t, err)
}
