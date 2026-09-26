package shorts

import (
	"context"
	"errors"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
)

// next_date used to be read off the 90 most recent dates, so every date older
// than those 90 reported the oldest of them as its next date: on 2026-09-26
// both 2015-03-02 and 2024-01-02 said 2026-05-18. The handler now asks the
// store for the first date after the requested one. The mock is strict, so a
// return of the old GetAvailableDates(90, "") lookup fails these tests.
func TestGetMarketByDateNextDate(t *testing.T) {
	cases := []struct {
		name    string
		date    string
		next    string
		nextErr error
		want    string
	}{
		{name: "an old date names the trading day after it", date: "2015-03-02", next: "2015-03-03", want: "2015-03-03"},
		{name: "a date before a holiday skips to the next trading day", date: "2023-12-22", next: "2023-12-27", want: "2023-12-27"},
		{name: "the latest date has no next date", date: "2026-09-21", next: "", want: ""},
		{name: "a failed lookup leaves it empty and still answers", date: "2024-01-02", nextErr: errors.New("db down"), want: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mocks.NewMockShortsStore(ctrl)
			store.EXPECT().GetMarketByDate(tc.date, int32(50), int32(0), false, false).Return(nil, 0, nil)
			store.EXPECT().GetAvailableDates(1, tc.date).Return([]string{"2015-02-27"}, "", "", 0, nil)
			store.EXPECT().GetNextAvailableDate(tc.date).Return(tc.next, tc.nextErr)

			res, err := newTestServer(t, store).GetMarketByDate(context.Background(),
				connect.NewRequest(&shortsv1alpha1.GetMarketByDateRequest{Date: tc.date}))
			require.NoError(t, err)
			require.Equal(t, tc.want, res.Msg.GetNextDate())
			require.Equal(t, "2015-02-27", res.Msg.GetPreviousDate())
		})
	}
}
