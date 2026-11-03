package shorts

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// The desk: the explorer's visual instruments over the register (spec section
// 13). Each rpc is one instrument's data. The map and the flows read the universe
// and one window statement; the movement reads one weekly statement; the index
// fund reads run over the snapshot tables. Only the default map's totals are
// cached, beside the universe, as the notices feed's first page is: every other
// desk read is made for the request.

const (
	// deskWindowDays is the default window of change: 91 days, both ends
	// inclusive, ending at the newest notice read.
	deskWindowDays = 91
	// deskMaxSpanDays is the longest window a request may name, end to end.
	deskMaxSpanDays = 366
	// deskWeeks is the most weeks the movement serves.
	deskWeeks = 52
	// deskDefaultLimit is what a limit of 0 means; deskMaxLimit is the most a
	// direction of the fund positions serves.
	deskDefaultLimit = 10
	deskMaxLimit     = 50
)

// deskStore is the desk's read surface, or nil when the store does not serve it.
func (s *ShortsServer) deskStore() shortsstore.OwnershipDeskStore {
	ds, _ := s.ownershipStore.(shortsstore.OwnershipDeskStore)
	return ds
}

// deskDate reads an optional YYYY-MM-DD date; "" is no date.
func deskDate(field, value string) (time.Time, bool, error) {
	if value == "" {
		return time.Time{}, false, nil
	}
	t, err := time.Parse(time.DateOnly, value)
	if err != nil {
		return time.Time{}, false, fmt.Errorf("%s must be a date, YYYY-MM-DD, got %q", field, value)
	}
	return t, true, nil
}

// deskWindow resolves a window of change to its two inclusive dates. An empty to
// ends the window at the newest notice (today when the register holds none), and
// an empty from starts it 90 days before to, so the default spans 91 days. A
// window that ends before it starts, or spans more than deskMaxSpanDays, is
// refused.
func deskWindow(from, to, newest string, today time.Time) (string, string, error) {
	f, hasFrom, err := deskDate("from", from)
	if err != nil {
		return "", "", err
	}
	t, hasTo, err := deskDate("to", to)
	if err != nil {
		return "", "", err
	}
	if !hasTo {
		if n, err := time.Parse(time.DateOnly, newest); err == nil {
			t = n
		} else {
			t = time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, time.UTC)
		}
	}
	if !hasFrom {
		f = t.AddDate(0, 0, -(deskWindowDays - 1))
	}
	if t.Before(f) {
		return "", "", fmt.Errorf("to must not be before from")
	}
	if t.Sub(f) > deskMaxSpanDays*24*time.Hour {
		return "", "", fmt.Errorf("from and to must be at most %d days apart", deskMaxSpanDays)
	}
	return f.Format(time.DateOnly), t.Format(time.DateOnly), nil
}

// deskWeeksOf clamps the movement's weeks: 0 and anything above deskWeeks are the
// full deskWeeks; a negative count is refused.
func deskWeeksOf(weeks int32) (int, error) {
	if weeks < 0 {
		return 0, fmt.Errorf("weeks must not be negative")
	}
	if weeks == 0 || weeks > deskWeeks {
		return deskWeeks, nil
	}
	return int(weeks), nil
}

// deskFundLimit clamps a direction's length in the fund positions: 0 is the
// default, anything above deskMaxLimit is that maximum, and a negative count is
// refused.
func deskFundLimit(limit int32) (int, error) {
	if limit < 0 {
		return 0, fmt.Errorf("limit must not be negative")
	}
	if limit == 0 {
		return deskDefaultLimit, nil
	}
	return min(int(limit), deskMaxLimit), nil
}

// deskAnchor is the newest notice's date, the day the movement's weeks end on.
func deskAnchor(newest string, today time.Time) time.Time {
	if n, err := time.Parse(time.DateOnly, newest); err == nil {
		return n
	}
	return time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, time.UTC)
}

// GetOwnershipMap is the map's stocks: the universe's figures, with each stock's
// net change in disclosed voting power over the window. The default window's
// totals are cached beside the universe.
func (s *ShortsServer) GetOwnershipMap(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.GetOwnershipMapRequest],
) (*connect.Response[shortsv1alpha1.GetOwnershipMapResponse], error) {
	ds := s.deskStore()
	if ds == nil {
		return connect.NewResponse(&shortsv1alpha1.GetOwnershipMapResponse{}), nil
	}
	u, err := s.ownershipUniverse.get(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("ownership map: %w", err))
	}
	from, to, err := deskWindow(req.Msg.From, req.Msg.To, u.data.stats.LatestAnnounced, s.ownershipUniverse.now())
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	var flows map[string]shortsstore.NoticeFlow
	if req.Msg.From == "" && req.Msg.To == "" {
		v, err := s.cache.GetOrSetWithTTL(s.cache.GetOwnershipMapKey(u.generation), u.ttlRemaining(), func() (any, error) {
			// The cache shares this read with every caller of the key, so the caller
			// that started it may leave.
			totals, err := ds.NoticeFlowByStock(context.WithoutCancel(ctx), from, to)
			if err != nil {
				return nil, err
			}
			return totals, nil
		})
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("ownership map: %w", err))
		}
		flows = v.(map[string]shortsstore.NoticeFlow)
	} else if flows, err = ds.NoticeFlowByStock(ctx, from, to); err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("ownership map: %w", err))
	}
	return connect.NewResponse(buildOwnershipMap(u, from, to, flows)), nil
}

// buildOwnershipMap is the map from the universe and the window's totals. A stock
// with no notice in the window has no flow figure, not a zero one.
func buildOwnershipMap(u *ownershipUniverse, from, to string, flows map[string]shortsstore.NoticeFlow) *shortsv1alpha1.GetOwnershipMapResponse {
	out := &shortsv1alpha1.GetOwnershipMapResponse{From: from, To: to, AsOf: u.data.stats.LatestAnnounced}
	for _, v := range registerUniverse(u) {
		m := &shortsv1alpha1.MapStock{
			StockCode: v.StockCode, CompanyName: v.CompanyName, Industry: v.Industry,
			MarketCap: v.MarketCap, HasMarketCap: v.HasMarketCap,
			DisclosedPct: v.DisclosedPct, InstitutionalPct: institutionalPct(v), HedgePct: kindPct(v, "hedge_fund"),
			IndexPct: v.IndexPct, HasIndexPct: v.HasIndexPct,
			ShortPct: v.ShortPct, HasShortPct: v.HasShortPct,
		}
		if f, ok := flows[v.StockCode]; ok {
			m.Notices = int32(f.Notices)
			m.FlowPp, m.HasFlowPp = f.Net, f.Has
		}
		out.Stocks = append(out.Stocks, m)
	}
	sort.Slice(out.Stocks, func(i, j int) bool {
		a, b := out.Stocks[i], out.Stocks[j]
		if a.DisclosedPct != b.DisclosedPct {
			return a.DisclosedPct > b.DisclosedPct
		}
		return a.StockCode < b.StockCode
	})
	return out
}

// GetOwnershipFlows is disclosed exposure by holder kind and industry (the
// current holdings, each interest once) and the window's change in it.
func (s *ShortsServer) GetOwnershipFlows(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.GetOwnershipFlowsRequest],
) (*connect.Response[shortsv1alpha1.GetOwnershipFlowsResponse], error) {
	ds := s.deskStore()
	if ds == nil {
		return connect.NewResponse(&shortsv1alpha1.GetOwnershipFlowsResponse{}), nil
	}
	u, err := s.ownershipUniverse.get(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("ownership flows: %w", err))
	}
	from, to, err := deskWindow(req.Msg.From, req.Msg.To, u.data.stats.LatestAnnounced, s.ownershipUniverse.now())
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	changes, err := ds.NoticeChangesByKindIndustry(ctx, from, to)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("ownership flows: %w", err))
	}
	return connect.NewResponse(buildOwnershipFlows(u, from, to, changes)), nil
}

// flowCell is one holder kind's holdings in one industry.
type flowCell struct {
	exposure    float64
	hasExposure bool
	holdings    int32
	largestCode string
	largestPct  float64
}

// buildOwnershipFlows is the positions from the universe's counted holdings, and
// the changes from the window's rows. Exposure is voting power over 100, times
// the stock's market cap; an interest in a stock with no market cap adds no
// exposure, and a cell with none has none.
func buildOwnershipFlows(u *ownershipUniverse, from, to string, changes []shortsstore.NoticeChangeRow) *shortsv1alpha1.GetOwnershipFlowsResponse {
	type cellKey struct{ kind, industry string }
	cells := map[cellKey]*flowCell{}
	for _, h := range countedHoldings(u.data.holdings, u.data.groups()) {
		k := cellKey{h.Kind, u.data.companies[h.StockCode].Industry}
		c := cells[k]
		if c == nil {
			c = &flowCell{}
			cells[k] = c
		}
		c.holdings++
		if v := u.views[h.StockCode]; v != nil && v.HasMarketCap {
			c.exposure += h.PresentPct / 100 * v.MarketCap
			c.hasExposure = true
		}
		if c.largestCode == "" || h.PresentPct > c.largestPct || (h.PresentPct == c.largestPct && h.StockCode < c.largestCode) {
			c.largestCode, c.largestPct = h.StockCode, h.PresentPct
		}
	}
	out := &shortsv1alpha1.GetOwnershipFlowsResponse{From: from, To: to, AsOf: u.data.stats.LatestAnnounced}
	for k, c := range cells {
		out.Positions = append(out.Positions, &shortsv1alpha1.FlowPosition{
			Kind: k.kind, Industry: k.industry, ExposureAud: c.exposure, HasExposure: c.hasExposure,
			Holdings: c.holdings, LargestCode: c.largestCode, LargestPct: c.largestPct,
		})
	}
	sort.Slice(out.Positions, func(i, j int) bool {
		a, b := out.Positions[i], out.Positions[j]
		if a.HasExposure != b.HasExposure {
			return a.HasExposure
		}
		if a.ExposureAud != b.ExposureAud {
			return a.ExposureAud > b.ExposureAud
		}
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		return a.Industry < b.Industry
	})
	for _, c := range changes {
		direction := "down"
		if c.Up {
			direction = "up"
		}
		out.Changes = append(out.Changes, &shortsv1alpha1.FlowChange{
			Kind: c.Kind, Industry: c.Industry, Direction: direction,
			ExposureAud: math.Abs(c.ExposureAUD), HasExposure: c.HasExposure, Notices: int32(c.Notices),
		})
	}
	sort.Slice(out.Changes, func(i, j int) bool {
		a, b := out.Changes[i], out.Changes[j]
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		if a.Industry != b.Industry {
			return a.Industry < b.Industry
		}
		return a.Direction == "up" && b.Direction != "up"
	})
	return out
}

// GetOwnershipActivity is each industry's notices by ISO week, for up to 52 weeks
// to the newest notice, gap-filled.
func (s *ShortsServer) GetOwnershipActivity(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.GetOwnershipActivityRequest],
) (*connect.Response[shortsv1alpha1.GetOwnershipActivityResponse], error) {
	ds := s.deskStore()
	if ds == nil {
		return connect.NewResponse(&shortsv1alpha1.GetOwnershipActivityResponse{}), nil
	}
	weeks, err := deskWeeksOf(req.Msg.Weeks)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	u, err := s.ownershipUniverse.get(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("ownership activity: %w", err))
	}
	anchor := deskAnchor(u.data.stats.LatestAnnounced, s.ownershipUniverse.now())
	first := mondayOf(anchor).AddDate(0, 0, -7*(weeks-1))
	rows, err := ds.NoticeWeeklyByIndustry(ctx, first.Format(time.DateOnly), anchor.Format(time.DateOnly))
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("ownership activity: %w", err))
	}
	return connect.NewResponse(buildOwnershipActivity(u, anchor, weeks, rows)), nil
}

// buildOwnershipActivity fills every industry of the register, and every industry
// with a notice in the range, across every week of it: a week with no notice
// reads zero counts and no net figure.
func buildOwnershipActivity(u *ownershipUniverse, anchor time.Time, weeks int, rows []shortsstore.IndustryWeekRow) *shortsv1alpha1.GetOwnershipActivityResponse {
	last := mondayOf(anchor)
	first := last.AddDate(0, 0, -7*(weeks-1))
	industries := map[string]bool{}
	for _, v := range registerUniverse(u) {
		industries[v.Industry] = true
	}
	byKey := make(map[string]shortsstore.IndustryWeekRow, len(rows))
	for _, r := range rows {
		industries[r.Industry] = true
		byKey[r.Industry+"|"+r.WeekStart] = r
	}
	names := make([]string, 0, len(industries))
	for name := range industries {
		names = append(names, name)
	}
	sort.Strings(names)
	out := &shortsv1alpha1.GetOwnershipActivityResponse{
		FromWeek: first.Format(time.DateOnly), ToWeek: last.Format(time.DateOnly), AsOf: u.data.stats.LatestAnnounced,
	}
	for _, name := range names {
		for w := first; !w.After(last); w = w.AddDate(0, 0, 7) {
			start := w.Format(time.DateOnly)
			row := &shortsv1alpha1.IndustryWeek{Industry: name, WeekStart: start}
			if r, ok := byKey[name+"|"+start]; ok {
				row.Became, row.Increased, row.Decreased = int32(r.Became), int32(r.Increased), int32(r.Decreased)
				row.Changed, row.Ceased, row.Nz = int32(r.Changed), int32(r.Ceased), int32(r.NZ)
				if r.NetPP != nil {
					row.NetPp, row.HasNetPp = *r.NetPP, true
				}
			}
			out.Rows = append(out.Rows, row)
		}
	}
	return out
}

// ListFundPositionChanges is the index fund positions: the file dates the tracked
// funds have, and each stock's change in weight between two of them.
func (s *ShortsServer) ListFundPositionChanges(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.ListFundPositionChangesRequest],
) (*connect.Response[shortsv1alpha1.ListFundPositionChangesResponse], error) {
	ds := s.deskStore()
	if ds == nil {
		return connect.NewResponse(&shortsv1alpha1.ListFundPositionChangesResponse{}), nil
	}
	limit, err := deskFundLimit(req.Msg.Limit)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	fromReq, toReq := req.Msg.From, req.Msg.To
	for _, d := range []struct{ field, value string }{{"from", fromReq}, {"to", toReq}} {
		if _, _, err := deskDate(d.field, d.value); err != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument, err)
		}
	}
	dates, err := ds.FundSnapshotDates(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("fund position changes: %w", err))
	}
	out := &shortsv1alpha1.ListFundPositionChangesResponse{SnapshotDates: dates}
	if len(dates) == 0 {
		return connect.NewResponse(out), nil
	}
	// An empty to is the newest file, so a from after it is named as such: the
	// caller sent no to date that could be wrong.
	toDefaulted := toReq == ""
	if toDefaulted {
		toReq = dates[len(dates)-1]
	}
	if fromReq > toReq {
		if toDefaulted {
			return nil, connect.NewError(connect.CodeInvalidArgument,
				fmt.Errorf("from must not be after the newest snapshot, %s", toReq))
		}
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("to must not be before from"))
	}
	// Each side is the newest file at or before the date the request names. The
	// store applies the same rule per fund, so the pairs are read at the dates used.
	// The default from is the file before the one the to date resolves to, so a to
	// date between two files still compares two of them.
	toUsed := newestSnapshot(dates, toReq)
	if fromReq == "" {
		fromReq = previousSnapshot(dates, toUsed)
	}
	fromUsed := newestSnapshot(dates, fromReq)
	// A from before the first file compares from the first file: nothing earlier
	// is held to compare with. A to before every file has no pair to read.
	if fromUsed == "" && toUsed != "" {
		fromUsed = dates[0]
	}
	out.From, out.To = fromUsed, toUsed
	if fromUsed == "" || toUsed == "" {
		return connect.NewResponse(out), nil
	}
	u, err := s.ownershipUniverse.get(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("fund position changes: %w", err))
	}
	pairs, err := ds.FundPositionPairs(ctx, fromUsed, toUsed)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("fund position changes: %w", err))
	}
	out.Rows = buildFundPositionChanges(u, pairs, limit)
	return connect.NewResponse(out), nil
}

// newestSnapshot is the newest file date at or before day, or "" when none is.
// The dates are YYYY-MM-DD, so they compare as strings.
func newestSnapshot(dates []string, day string) string {
	for i := len(dates) - 1; i >= 0; i-- {
		if dates[i] <= day {
			return dates[i]
		}
	}
	return ""
}

// previousSnapshot is the newest file date strictly before day, or day itself
// when the register has none before it, so the default window is empty then.
func previousSnapshot(dates []string, day string) string {
	for i := len(dates) - 1; i >= 0; i-- {
		if dates[i] < day {
			return dates[i]
		}
	}
	return day
}

// buildFundPositionChanges is the stocks whose weight moved between the two
// dates. The largest rises and the largest falls (at most limit of each) come
// first, in one run ordered by the size of the move; then the stocks new on the
// later date and dropped since the earlier one, each at most limit long.
//
// A stock's weight and value on a date sum every tracked fund holding it that day.
// A stock held on both dates is a change like any other, whichever funds hold it:
// weight to less weight from is the delta, and a fund that starts or stops holding
// it moves the sum. New and dropped are a stock absent from every tracked fund on
// one of the two dates. A holding with no stated figure makes that side's sum
// unknown, never a sum short of it, so a stock with an unknown side has no delta.
func buildFundPositionChanges(u *ownershipUniverse, pairs []shortsstore.FundPositionPair, limit int) []*shortsv1alpha1.FundPositionChange {
	by := map[string]*fundPositionAgg{}
	for _, p := range pairs {
		a := by[p.StockCode]
		if a == nil {
			a = &fundPositionAgg{funds: map[string]bool{}}
			by[p.StockCode] = a
		}
		a.funds[p.InstitutionSlug+"|"+p.FundName] = true
		a.inFrom = a.inFrom || p.InFrom
		a.inTo = a.inTo || p.InTo
		if a.secName == "" {
			a.secName = p.SecurityName
		}
		a.weightFrom.add(p.InFrom, p.FromWeight)
		a.weightTo.add(p.InTo, p.ToWeight)
		a.valueFrom.add(p.InFrom, p.FromValue)
		a.valueTo.add(p.InTo, p.ToValue)
	}
	var moves, added, dropped []*shortsv1alpha1.FundPositionChange
	var rises, falls []*shortsv1alpha1.FundPositionChange
	for code, a := range by {
		row := &shortsv1alpha1.FundPositionChange{StockCode: code, CompanyName: u.data.companies[code].Name, Funds: int32(len(a.funds))}
		if row.CompanyName == "" {
			row.CompanyName = a.secName
		}
		switch {
		case a.inFrom && a.inTo:
			if !a.weightFrom.known() || !a.weightTo.known() {
				continue
			}
			row.State = "current"
			row.DeltaPp, row.HasDelta = a.weightTo.sum-a.weightFrom.sum, true
		case a.inTo:
			row.State = "new"
		case a.inFrom:
			row.State = "dropped"
		default:
			continue
		}
		row.WeightFromPct, row.HasWeightFrom = a.weightFrom.sum, a.weightFrom.known()
		row.WeightToPct, row.HasWeightTo = a.weightTo.sum, a.weightTo.known()
		row.ValueFromAud, row.HasValueFrom = a.valueFrom.sum, a.valueFrom.known()
		row.ValueToAud, row.HasValueTo = a.valueTo.sum, a.valueTo.known()
		switch {
		case row.State == "new":
			added = append(added, row)
		case row.State == "dropped":
			dropped = append(dropped, row)
		case row.DeltaPp > 0:
			rises = append(rises, row)
		case row.DeltaPp < 0:
			falls = append(falls, row)
		}
	}
	sort.Slice(rises, func(i, j int) bool {
		if rises[i].DeltaPp != rises[j].DeltaPp {
			return rises[i].DeltaPp > rises[j].DeltaPp
		}
		return rises[i].StockCode < rises[j].StockCode
	})
	sort.Slice(falls, func(i, j int) bool {
		if falls[i].DeltaPp != falls[j].DeltaPp {
			return falls[i].DeltaPp < falls[j].DeltaPp
		}
		return falls[i].StockCode < falls[j].StockCode
	})
	moves = append(moves, rises[:min(limit, len(rises))]...)
	moves = append(moves, falls[:min(limit, len(falls))]...)
	// The size is rounded to a millionth of a point, so float noise in two equal
	// moves (0.2 less 0.1 against 0.3 less 0.2) cannot reorder them.
	size := func(d float64) float64 { return math.Round(math.Abs(d)*1e6) / 1e6 }
	sort.Slice(moves, func(i, j int) bool {
		if mi, mj := size(moves[i].DeltaPp), size(moves[j].DeltaPp); mi != mj {
			return mi > mj
		}
		return moves[i].StockCode < moves[j].StockCode
	})
	sort.Slice(added, func(i, j int) bool {
		if added[i].WeightToPct != added[j].WeightToPct {
			return added[i].WeightToPct > added[j].WeightToPct
		}
		return added[i].StockCode < added[j].StockCode
	})
	sort.Slice(dropped, func(i, j int) bool {
		if dropped[i].WeightFromPct != dropped[j].WeightFromPct {
			return dropped[i].WeightFromPct > dropped[j].WeightFromPct
		}
		return dropped[i].StockCode < dropped[j].StockCode
	})
	out := moves
	out = append(out, added[:min(limit, len(added))]...)
	out = append(out, dropped[:min(limit, len(dropped))]...)
	return out
}

// fundPositionAgg is one stock across the tracked funds on the two dates.
type fundPositionAgg struct {
	secName              string
	funds                map[string]bool
	inFrom, inTo         bool
	weightFrom, weightTo fundFigure
	valueFrom, valueTo   fundFigure
}

// fundFigure is a sum over the funds holding a stock on one date. A holding that
// states no figure makes the sum unknown.
type fundFigure struct {
	sum     float64
	held    bool
	missing bool
}

// add counts a fund's holding on a date: held says the fund holds the stock then,
// and v is its stated figure, nil when it states none.
func (f *fundFigure) add(held bool, v *float64) {
	if !held {
		return
	}
	f.held = true
	if v == nil {
		f.missing = true
		return
	}
	f.sum += *v
}

// known reports whether the sum is a figure: some fund holds the stock on the date
// and every holding states its figure.
func (f fundFigure) known() bool {
	return f.held && !f.missing
}

// GetStockFundSeries is one stock's weight and value in each tracked fund at each
// file date. A stock no fund holds has no funds, not an error.
func (s *ShortsServer) GetStockFundSeries(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.GetStockFundSeriesRequest],
) (*connect.Response[shortsv1alpha1.GetStockFundSeriesResponse], error) {
	code := strings.ToUpper(strings.TrimSpace(req.Msg.StockCode))
	if !ownershipCodeRegex.MatchString(code) {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("stock_code %q is not 1 to 6 letters or digits", req.Msg.StockCode))
	}
	ds := s.deskStore()
	if ds == nil {
		return connect.NewResponse(&shortsv1alpha1.GetStockFundSeriesResponse{StockCode: code}), nil
	}
	u, err := s.ownershipUniverse.get(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("stock fund series: %w", err))
	}
	rows, err := ds.StockFundSeries(ctx, code)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("stock fund series: %w", err))
	}
	return connect.NewResponse(buildStockFundSeries(u, code, rows)), nil
}

// buildStockFundSeries groups the rows by fund. The rows arrive grouped and oldest
// first, so each fund's points are one run.
func buildStockFundSeries(u *ownershipUniverse, code string, rows []shortsstore.FundSeriesRow) *shortsv1alpha1.GetStockFundSeriesResponse {
	out := &shortsv1alpha1.GetStockFundSeriesResponse{StockCode: code}
	insts := u.data.institutionBySlug()
	var cur *shortsv1alpha1.FundSeries
	key := ""
	for _, r := range rows {
		k := r.InstitutionSlug + "|" + r.FundName + "|" + r.SourceKind
		if cur == nil || k != key {
			name := insts[r.InstitutionSlug].Name
			if name == "" {
				name = r.InstitutionSlug
			}
			cur = &shortsv1alpha1.FundSeries{
				InstitutionSlug: r.InstitutionSlug, InstitutionName: name, FundName: r.FundName, SourceKind: r.SourceKind,
			}
			out.Funds = append(out.Funds, cur)
			key = k
		}
		p := &shortsv1alpha1.FundPoint{AsAt: r.AsAt}
		if r.Weight != nil {
			p.WeightPct, p.HasWeight = *r.Weight, true
		}
		if r.Value != nil {
			p.ValueAud, p.HasValue = *r.Value, true
		}
		cur.Points = append(cur.Points, p)
	}
	return out
}
