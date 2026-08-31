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

func TestGetEventTimeline_HandlerReturnsEvents(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	// Lowercase input → handler normalizes to "BHP"; DaysBack=0 defaults to a full year (365).
	mockStore.EXPECT().
		GetEventTimeline("BHP", int32(365), int32(50)).
		Return([]*shortsstore.TimelineEventRow{
			{
				Date:             "2026-06-15",
				Type:             "announcement",
				Title:            "Quarterly Results",
				Detail:           "BHP reports record earnings",
				URL:              "https://example.com/pdf/1",
				Sentiment:        "",
				IsPriceSensitive: true,
			},
			{
				Date:      "2026-06-10",
				Type:      "director_trade",
				Title:     "Jane Smith buy",
				Detail:    "$1.2M",
				URL:       "https://example.com/trade/2",
				Sentiment: "",
			},
			{
				Date:             "2026-06-05",
				Type:             "news",
				Title:            "BHP under pressure",
				Detail:           "Short sellers circle the stock",
				URL:              "https://news.example.com/3",
				Sentiment:        "negative",
				IsPriceSensitive: true,
			},
			{
				Date:   "2026-06-01",
				Type:   "short_spike",
				Title:  "Short interest +2.3pp",
				Detail: "Short position reached 8.50%",
			},
		}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetEventTimeline(context.Background(), connect.NewRequest(&shortsv1alpha1.GetEventTimelineRequest{
		StockCode: "bhp",
		// DaysBack and Limit at zero → handler applies defaults (365 and 50)
	}))

	require.NoError(t, err)
	require.Len(t, resp.Msg.Events, 4)

	// Events must map through in order (sorted by store; handler preserves order)
	assert.Equal(t, "2026-06-15", resp.Msg.Events[0].Date)
	assert.Equal(t, "announcement", resp.Msg.Events[0].Type)
	assert.Equal(t, "Quarterly Results", resp.Msg.Events[0].Title)
	assert.Equal(t, "BHP reports record earnings", resp.Msg.Events[0].Detail)
	assert.True(t, resp.Msg.Events[0].IsPriceSensitive)

	assert.Equal(t, "director_trade", resp.Msg.Events[1].Type)
	assert.Equal(t, "Jane Smith buy", resp.Msg.Events[1].Title)

	assert.Equal(t, "news", resp.Msg.Events[2].Type)
	assert.Equal(t, "negative", resp.Msg.Events[2].Sentiment)
	assert.True(t, resp.Msg.Events[2].IsPriceSensitive)

	assert.Equal(t, "short_spike", resp.Msg.Events[3].Type)
	assert.Equal(t, "Short interest +2.3pp", resp.Msg.Events[3].Title)
}

func TestGetEventTimeline_HandlerRejectsEmptyStock(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))
	_, err := srv.GetEventTimeline(context.Background(), connect.NewRequest(&shortsv1alpha1.GetEventTimelineRequest{}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

func TestGetEventTimeline_HandlerDefaultsAndCaps(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	// Verify: daysBack > 365 is capped to 365, limit > 200 is capped to 200
	mockStore.EXPECT().
		GetEventTimeline("CBA", int32(365), int32(200)).
		Return([]*shortsstore.TimelineEventRow{}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetEventTimeline(context.Background(), connect.NewRequest(&shortsv1alpha1.GetEventTimelineRequest{
		StockCode: "CBA",
		DaysBack:  9999,
		Limit:     9999,
	}))

	require.NoError(t, err)
	assert.Empty(t, resp.Msg.Events)
}
