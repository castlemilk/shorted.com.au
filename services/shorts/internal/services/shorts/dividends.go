package shorts

import (
	"context"
	"fmt"
	"time"
	_ "time/tzdata" // the API image is distroless; embed the zone the trailing window is dated in

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// dividendZone is the ASX's zone: an ex-date is a Sydney date.
var dividendZone = func() *time.Location {
	loc, err := time.LoadLocation("Australia/Sydney")
	if err != nil {
		panic(fmt.Sprintf("load Australia/Sydney: %v", err)) // unreachable with time/tzdata embedded
	}
	return loc
}()

// sydneyTodayDate returns today's date in Sydney as YYYY-MM-DD, the format of ex_date.
func sydneyTodayDate(nowFn func() time.Time) string {
	return nowFn().In(dividendZone).Format("2006-01-02")
}

// parseExDate parses an ex_date string (YYYY-MM-DD format) into a time.Time at midnight UTC.
func parseExDate(dateStr string) (time.Time, error) {
	return time.Parse("2006-01-02", dateStr)
}

// trailingYieldSum calculates the sum of amount_per_share for dividends with ex_date
// within the trailing 365 days (from (today-365d, today], exclusive of the lower bound,
// inclusive of today). The nowFn is injectable for testing.
func trailingYieldSum(dividends []*shortsstore.DividendRecord, nowFn func() time.Time) float64 {
	todayStr := sydneyTodayDate(nowFn)
	today, _ := parseExDate(todayStr)
	startDate := today.AddDate(0, 0, -365)

	var sum float64
	for _, d := range dividends {
		exDate, err := parseExDate(d.ExDate)
		if err != nil {
			// Invalid date format, skip
			continue
		}
		// Include if ex_date is after startDate and on or before today
		if exDate.After(startDate) && exDate.Before(today.AddDate(0, 0, 1)) {
			sum += d.AmountPerShare
		}
	}
	return sum
}

// GetDividendHistory retrieves dividend payment history for a stock
func (s *ShortsServer) GetDividendHistory(ctx context.Context, req *connect.Request[shortsv1alpha1.GetDividendHistoryRequest]) (*connect.Response[shortsv1alpha1.GetDividendHistoryResponse], error) {
	SetDefaultValues(req.Msg)
	if err := ValidateGetDividendHistoryRequest(req.Msg); err != nil {
		s.logger.Errorf("validation failed for GetDividendHistory: %v", err)
		return nil, err
	}

	s.logger.Debugf("get dividend history: stock_code=%s, years=%d", req.Msg.StockCode, req.Msg.Years)

	cacheKey := s.cache.GetDividendHistoryKey(req.Msg.StockCode, req.Msg.Years)

	cachedResponse, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		dividends, totalCount, err := s.store.GetDividendHistory(req.Msg.StockCode, req.Msg.Years)
		if err != nil {
			return nil, err
		}

		protoDividends := make([]*shortsv1alpha1.DividendRecord, len(dividends))
		for i, d := range dividends {
			record := &shortsv1alpha1.DividendRecord{
				Id:                 d.ID,
				StockCode:          d.StockCode,
				ExDate:             d.ExDate,
				AmountPerShare:     d.AmountPerShare,
				FrankingPercentage: d.FrankingPercentage,
				DividendType:       d.DividendType,
			}
			if d.PaymentDate != nil {
				record.PaymentDate = *d.PaymentDate
			}
			protoDividends[i] = record
		}

		// Calculate trailing 12-month yield: sum of amount_per_share for dividends
		// with ex_date in the past 365 days (today-365d, today], in AUD per share
		trailingYield := trailingYieldSum(dividends, time.Now)

		return &shortsv1alpha1.GetDividendHistoryResponse{
			Dividends:     protoDividends,
			TotalCount:    int32(totalCount),
			TrailingYield: trailingYield,
		}, nil
	})

	if err != nil {
		s.logger.Errorf("database error in GetDividendHistory: stock_code=%s, err=%v", req.Msg.StockCode, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get dividend history"))
	}

	response := cachedResponse.(*shortsv1alpha1.GetDividendHistoryResponse)
	return connect.NewResponse(response), nil
}
