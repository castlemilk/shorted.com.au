package shorts

import (
	"context"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"golang.org/x/sync/singleflight"
)

// OwnershipInsightsService (ownership_insights.proto): the register in one time
// window, pre-aggregated so the web receives small answers.
//
// Two measures, never blended into one number:
//   - fund holdings, from the index fund and super option files on record. A
//     fund's position at a date is its newest file on or before it. A change
//     compares a fund only with itself (its file at the window's start against
//     its newest file at the end), so a fund whose first file falls inside the
//     window is never read as new money. Shares are compared, and the change is
//     valued at the later file's price, so a price move is not a position move.
//   - disclosed stakes, from the notices. The register is the current one
//     (each interest counted once, as the newest notices read state it). The
//     change is what the window's notices state themselves: present less
//     previous, where a notice states both. No past register is rebuilt, for
//     the reason the Holder Lanes give: withheld notices and the overlap rule
//     would make a reconstruction a guess.
//
// Caching follows the universe: one base (the fund files' index and every
// notice read) per universe generation, built on the first insights request,
// and a bounded set of window answers under the same generation, so no answer
// outlives the universe it was built beside.

const (
	// insightsDefaultWindowDays is the default window, ending on the newest
	// date read.
	insightsDefaultWindowDays = 90
	// insightsWeekBucketMaxDays is the longest window bucketed by week; a
	// longer one is bucketed by month.
	insightsWeekBucketMaxDays = 120
	// insightsMaxMonths caps a window's length: the oldest months fall off.
	insightsMaxMonths = 48
	// insightsNoticeLimit bounds the notices a base reads, newest first.
	insightsNoticeLimit = 60000
	// insightsStockCap is how many stocks each measure lists; the rest of
	// each sector is a remainder.
	insightsStockCap = 250
	// insightsFlowInstitutions and insightsFlowSectors are the Sankey's named
	// nodes; the rest fold into "Other" and "Other sectors".
	insightsFlowInstitutions = 10
	insightsFlowSectors      = 10
	// insightsMoves is how many stated moves a window lists.
	insightsMoves = 20
	// insightsDetailNotices is how many notices a stock's detail lists.
	insightsDetailNotices = 20
	// insightsWindowCacheSize bounds the window answers held per generation.
	insightsWindowCacheSize = 64
	// insightsSectorMaxLen bounds a sector argument.
	insightsSectorMaxLen = 120
)

const insightsDateLayout = "2006-01-02"

var insightsStockCodePattern = regexp.MustCompile(`^[A-Z0-9]{1,6}$`)

// placeholderIndustries stand in an industry field that holds no industry
// (web/src/@/lib/industry-placeholder.ts keeps the same list). A stock with one
// sits in the sector "", which the web prints as Other.
var placeholderIndustries = map[string]bool{
	"not applic": true, "not applicable": true, "class pend": true, "other": true,
}

// insightSector is the sector a company's industry names.
func insightSector(industry string) string {
	name := strings.TrimSpace(industry)
	if placeholderIndustries[strings.ToLower(name)] {
		return ""
	}
	return name
}

// ownershipInsightsHolder keeps the base and the window answers of one
// universe generation. Its zero value is ready.
type ownershipInsightsHolder struct {
	mu      sync.Mutex
	gen     int64
	base    *insightsBase
	windows map[string]*shortsv1alpha1.GetOwnershipInsightsResponse
	order   []string
	sf      singleflight.Group
}

// reset drops everything held for an older generation. Called with mu held.
func (h *ownershipInsightsHolder) reset(gen int64) {
	if h.gen == gen {
		return
	}
	h.gen, h.base, h.windows, h.order = gen, nil, map[string]*shortsv1alpha1.GetOwnershipInsightsResponse{}, nil
}

// getBase returns the generation's base, building it once for every caller
// that arrives while it builds.
func (h *ownershipInsightsHolder) getBase(gen int64, build func() (*insightsBase, error)) (*insightsBase, error) {
	h.mu.Lock()
	h.reset(gen)
	if b := h.base; b != nil {
		h.mu.Unlock()
		return b, nil
	}
	h.mu.Unlock()
	v, err, _ := h.sf.Do(fmt.Sprintf("base|%d", gen), func() (any, error) {
		b, err := build()
		if err != nil {
			return nil, err
		}
		h.mu.Lock()
		if h.gen == gen {
			h.base = b
		}
		h.mu.Unlock()
		return b, nil
	})
	if err != nil {
		return nil, err
	}
	return v.(*insightsBase), nil
}

// getWindow returns a window answer of the generation, building it once. The
// answers are bounded: past insightsWindowCacheSize the oldest is dropped.
func (h *ownershipInsightsHolder) getWindow(gen int64, key string, build func() (*shortsv1alpha1.GetOwnershipInsightsResponse, error)) (*shortsv1alpha1.GetOwnershipInsightsResponse, error) {
	h.mu.Lock()
	h.reset(gen)
	if r, ok := h.windows[key]; ok {
		h.mu.Unlock()
		return r, nil
	}
	h.mu.Unlock()
	v, err, _ := h.sf.Do(fmt.Sprintf("window|%d|%s", gen, key), func() (any, error) {
		r, err := build()
		if err != nil {
			return nil, err
		}
		h.mu.Lock()
		if h.gen == gen {
			if _, ok := h.windows[key]; !ok {
				h.windows[key] = r
				h.order = append(h.order, key)
				for len(h.order) > insightsWindowCacheSize {
					delete(h.windows, h.order[0])
					h.order = h.order[1:]
				}
			}
		}
		h.mu.Unlock()
		return r, nil
	})
	if err != nil {
		return nil, err
	}
	return v.(*shortsv1alpha1.GetOwnershipInsightsResponse), nil
}

// insightsFund is one fund's files, oldest first.
type insightsFund struct {
	slug, name, code, sourceKind string
	files                        []shortsstore.FundSnapshotRow
}

// at is the fund's newest file on or before d, or nil.
func (f *insightsFund) at(d string) *shortsstore.FundSnapshotRow {
	i := sort.Search(len(f.files), func(i int) bool { return f.files[i].AsAt > d })
	if i == 0 {
		return nil
	}
	return &f.files[i-1]
}

// startIn is the file a window's change starts from: the newest on or before
// from, else the oldest inside the window, else nil.
func (f *insightsFund) startIn(from, to string) *shortsstore.FundSnapshotRow {
	if s := f.at(from); s != nil {
		return s
	}
	i := sort.Search(len(f.files), func(i int) bool { return f.files[i].AsAt >= from })
	if i < len(f.files) && f.files[i].AsAt <= to {
		return &f.files[i]
	}
	return nil
}

// insightNotice is a notice as the insights read it: dated by its event (its
// release when it states none), with the change it states.
type insightNotice struct {
	row      shortsstore.SubstantialNoticeRow
	date     string
	event    string
	delta    float64
	hasDelta bool
}

// insightsBase is what every window of one generation reads: the fund files'
// index and every notice read. It is immutable once built.
type insightsBase struct {
	funds         []*insightsFund // by slug, then fund name
	fundBySnap    map[int64]*insightsFund
	snapshotDates []string
	notices       []insightNotice // oldest first
	noticesFrom   string
	noticesTo     string
	timelineFrom  string
	timelineTo    string
	timeline      []*shortsv1alpha1.InsightTimelineMonth
}

// newInsightsBase indexes the files and the notices. It is pure.
func newInsightsBase(snaps []shortsstore.FundSnapshotRow, notices []shortsstore.SubstantialNoticeRow) *insightsBase {
	b := &insightsBase{fundBySnap: map[int64]*insightsFund{}}
	byKey := map[string]*insightsFund{}
	dates := map[string]bool{}
	files := map[string]int{}
	for _, s := range snaps {
		if !validInsightDate(s.AsAt) {
			continue
		}
		key := s.InstitutionSlug + "|" + s.FundName
		f := byKey[key]
		if f == nil {
			f = &insightsFund{slug: s.InstitutionSlug, name: s.FundName, code: s.FundCode, sourceKind: s.SourceKind}
			byKey[key] = f
			b.funds = append(b.funds, f)
		}
		f.files = append(f.files, s)
		b.fundBySnap[s.ID] = f
		dates[s.AsAt] = true
		files[s.AsAt[:7]]++
	}
	for _, f := range b.funds {
		sort.SliceStable(f.files, func(i, j int) bool {
			if f.files[i].AsAt != f.files[j].AsAt {
				return f.files[i].AsAt < f.files[j].AsAt
			}
			return f.files[i].ID < f.files[j].ID
		})
		// One file per date: a re-run rewrites its row, so two ids on one date
		// are not expected, and the later id wins if they occur.
		dedup := f.files[:0]
		for i, s := range f.files {
			if i+1 < len(f.files) && f.files[i+1].AsAt == s.AsAt {
				continue
			}
			dedup = append(dedup, s)
		}
		f.files = dedup
		if f.code == "" && len(f.files) > 0 {
			f.code = f.files[len(f.files)-1].FundCode
		}
	}
	sort.Slice(b.funds, func(i, j int) bool {
		if b.funds[i].slug != b.funds[j].slug {
			return b.funds[i].slug < b.funds[j].slug
		}
		return b.funds[i].name < b.funds[j].name
	})
	for d := range dates {
		b.snapshotDates = append(b.snapshotDates, d)
	}
	sort.Strings(b.snapshotDates)

	noticeMonths := map[string]int{}
	for _, n := range notices {
		date := n.EventDate
		if !validInsightDate(date) {
			date = n.AnnouncedOn
		}
		if !validInsightDate(date) {
			continue
		}
		in := insightNotice{row: n, date: date, event: n.Event()}
		if n.PresentPct != nil && n.PreviousPct != nil {
			in.delta, in.hasDelta = *n.PresentPct-*n.PreviousPct, true
		}
		b.notices = append(b.notices, in)
		noticeMonths[date[:7]]++
	}
	sort.SliceStable(b.notices, func(i, j int) bool {
		if b.notices[i].date != b.notices[j].date {
			return b.notices[i].date < b.notices[j].date
		}
		return b.notices[i].row.AnnouncementURL < b.notices[j].row.AnnouncementURL
	})
	if len(b.notices) > 0 {
		b.noticesFrom, b.noticesTo = b.notices[0].date, b.notices[len(b.notices)-1].date
	}
	b.timelineFrom, b.timelineTo = b.noticesFrom, b.noticesTo
	if len(b.snapshotDates) > 0 {
		first, last := b.snapshotDates[0], b.snapshotDates[len(b.snapshotDates)-1]
		if b.timelineFrom == "" || first < b.timelineFrom {
			b.timelineFrom = first
		}
		if last > b.timelineTo {
			b.timelineTo = last
		}
	}
	if b.timelineFrom != "" {
		for m := monthStart(mustDate(b.timelineFrom)); !m.After(mustDate(b.timelineTo)); m = m.AddDate(0, 1, 0) {
			key := m.Format("2006-01")
			b.timeline = append(b.timeline, &shortsv1alpha1.InsightTimelineMonth{
				Month: key, Notices: int32(noticeMonths[key]), Files: int32(files[key]),
			})
		}
	}
	return b
}

func validInsightDate(d string) bool {
	if len(d) != len(insightsDateLayout) {
		return false
	}
	_, err := time.Parse(insightsDateLayout, d)
	return err == nil
}

func mustDate(d string) time.Time {
	t, err := time.Parse(insightsDateLayout, d)
	if err != nil {
		panic(fmt.Sprintf("insights: invalid date %q", d))
	}
	return t
}

func formatInsightDate(t time.Time) string { return t.Format(insightsDateLayout) }

func monthStart(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC)
}

var errInsightsWindow = errors.New("window_from is after window_to")

// resolveWindow is the window a request asks for: the default when a bound is
// empty, clamped to the timeline and to insightsMaxMonths. A from after the to
// is refused. An empty timeline serves an empty window.
func (b *insightsBase) resolveWindow(from, to string) (string, string, error) {
	if from != "" && to != "" && from > to {
		return "", "", errInsightsWindow
	}
	if b.timelineTo == "" {
		return "", "", nil
	}
	if to == "" || to > b.timelineTo {
		to = b.timelineTo
	}
	if to < b.timelineFrom {
		to = b.timelineFrom
	}
	if from == "" {
		from = formatInsightDate(mustDate(to).AddDate(0, 0, -(insightsDefaultWindowDays - 1)))
	}
	if from < b.timelineFrom {
		from = b.timelineFrom
	}
	if from > to {
		from = to
	}
	if floor := formatInsightDate(mustDate(to).AddDate(0, -insightsMaxMonths, 1)); from < floor {
		from = floor
	}
	return from, to, nil
}

// insightBuckets splits a window into weeks (Monday to Sunday) when it spans
// at most insightsWeekBucketMaxDays, else into calendar months, each clipped
// to the window.
func insightBuckets(from, to string) (string, []*shortsv1alpha1.InsightBucket) {
	if from == "" || to == "" {
		return "", nil
	}
	f, t := mustDate(from), mustDate(to)
	days := int(t.Sub(f).Hours()/24) + 1
	var out []*shortsv1alpha1.InsightBucket
	if days <= insightsWeekBucketMaxDays {
		for start := f; !start.After(t); {
			// Sunday ends a week: time.Weekday counts Sunday as 0.
			end := start.AddDate(0, 0, (7-int(start.Weekday()))%7)
			if end.After(t) {
				end = t
			}
			out = append(out, &shortsv1alpha1.InsightBucket{Start: formatInsightDate(start), End: formatInsightDate(end)})
			start = end.AddDate(0, 0, 1)
		}
		return "week", out
	}
	for start := f; !start.After(t); {
		end := monthStart(start).AddDate(0, 1, -1)
		if end.After(t) {
			end = t
		}
		out = append(out, &shortsv1alpha1.InsightBucket{Start: formatInsightDate(start), End: formatInsightDate(end)})
		start = end.AddDate(0, 0, 1)
	}
	return "month", out
}

// GetOwnershipInsights is the register in one window.
func (s *ShortsServer) GetOwnershipInsights(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.GetOwnershipInsightsRequest],
) (*connect.Response[shortsv1alpha1.GetOwnershipInsightsResponse], error) {
	from := strings.TrimSpace(req.Msg.WindowFrom)
	to := strings.TrimSpace(req.Msg.WindowTo)
	for _, d := range []string{from, to} {
		if d != "" && !validInsightDate(d) {
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("window dates must be YYYY-MM-DD, got %q", d))
		}
	}
	sector := strings.TrimSpace(req.Msg.Sector)
	if len(sector) > insightsSectorMaxLen {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("sector is longer than %d characters", insightsSectorMaxLen))
	}
	code := strings.ToUpper(strings.TrimSpace(req.Msg.StockCode))
	if code != "" && !insightsStockCodePattern.MatchString(code) {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("stock_code must be an ASX code"))
	}
	if from != "" && to != "" && from > to {
		return nil, connect.NewError(connect.CodeInvalidArgument, errInsightsWindow)
	}
	if s.ownershipStore == nil {
		return connect.NewResponse(&shortsv1alpha1.GetOwnershipInsightsResponse{Window: &shortsv1alpha1.InsightWindow{}}), nil
	}
	u, err := s.ownershipUniverse.get(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("ownership insights: %w", err))
	}
	fundStore, _ := s.ownershipStore.(shortsstore.OwnershipInsightsStore)
	holder := s.ownershipInsights
	if holder == nil {
		// A server built without the holder (a test's literal) caches nothing.
		holder = &ownershipInsightsHolder{}
	}
	base, err := holder.getBase(u.generation, func() (*insightsBase, error) {
		return s.buildInsightsBase(ctx, fundStore)
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("ownership insights: %w", err))
	}
	wFrom, wTo, err := base.resolveWindow(from, to)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	key := strings.Join([]string{wFrom, wTo, sector, code}, "|")
	resp, err := holder.getWindow(u.generation, key, func() (*shortsv1alpha1.GetOwnershipInsightsResponse, error) {
		// Shared by every caller of the key, so the caller that started it may
		// leave; each store read is bounded by ownershipTimeout.
		return buildOwnershipInsights(context.WithoutCancel(ctx), u, base, fundStore, insightsQuery{from: wFrom, to: wTo, sector: sector, stockCode: code})
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("ownership insights: %w", err))
	}
	return connect.NewResponse(resp), nil
}

// buildInsightsBase reads the fund files' index and every notice: two
// statements per generation.
func (s *ShortsServer) buildInsightsBase(ctx context.Context, fundStore shortsstore.OwnershipInsightsStore) (*insightsBase, error) {
	bctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), ownershipBuildTimeout)
	defer cancel()
	var snaps []shortsstore.FundSnapshotRow
	if fundStore != nil {
		var err error
		if snaps, err = fundStore.FundSnapshots(bctx); err != nil {
			return nil, err
		}
	}
	notices, err := s.ownershipStore.SubstantialNotices(bctx, shortsstore.OwnershipFilter{}, insightsNoticeLimit)
	if err != nil {
		return nil, err
	}
	return newInsightsBase(snaps, notices), nil
}

// insightsQuery is one resolved request.
type insightsQuery struct {
	from, to, sector, stockCode string
}

// insightsChangeReader is the one store read a window's changes need. A nil
// reader reads no fund data.
type insightsChangeReader interface {
	FundSnapshotHoldings(ctx context.Context, snapshotIDs []int64, stockCode string) ([]shortsstore.FundSnapshotHoldingRow, error)
	FundHoldingChanges(ctx context.Context, pairs []shortsstore.FundSnapshotPair, stockCodes []string) ([]shortsstore.FundHoldingChangeRow, error)
}

// stockAgg is one stock's figures in a window.
type stockAgg struct {
	code, sector               string
	fundValue, fundUnits       float64
	hasFundValue, hasFundUnits bool
	funds                      int
	superValue                 float64
	hasSuperValue              bool
	flow, startAtEnd           float64
	unitsFrom, unitsTo         float64
	hasFlow, hasUnitsFrom      bool
	disclosedPct               float64
	interests                  int
	investorInterests          int
	disclosedValue             float64
	hasDisclosedValue          bool
	netPP                      float64
	notices, rises, falls      int
	became, ceased             int
}

func (a *stockAgg) addNotice(n insightNotice) {
	a.notices++
	if n.hasDelta {
		a.netPP += n.delta
		switch {
		case n.delta > 0:
			a.rises++
		case n.delta < 0:
			a.falls++
		}
	}
	switch n.event {
	case shortsstore.EventBecame:
		a.became++
	case shortsstore.EventCeased:
		a.ceased++
	}
}

// changeFlow values one change row: the change in shares at the later file's
// price (the earlier file's for a position gone), plus the change in value of
// rows that state no shares. startAtEnd is the earlier shares at that price.
func changeFlow(r shortsstore.FundHoldingChangeRow) (flow, startAtEnd float64) {
	price := 0.0
	switch {
	case r.UnitsTo > 0:
		price = r.UnitValueTo / r.UnitsTo
	case r.UnitsFrom > 0:
		price = r.UnitValueFrom / r.UnitsFrom
	}
	flow = (r.UnitsTo-r.UnitsFrom)*price + (r.ValueOnlyTo - r.ValueOnlyFrom)
	startAtEnd = r.UnitsFrom*price + r.ValueOnlyFrom
	return flow, startAtEnd
}

// windowPairs are the index funds' window pairs (group -1) and bucket pairs
// (group = bucket index). The window's start and end file ranges and the
// funds compared are reported beside them.
type windowPairs struct {
	pairs            []shortsstore.FundSnapshotPair
	windowPairByFund map[*insightsFund]shortsstore.FundSnapshotPair
	bucketFunds      []int
	startFrom        string
	startTo          string
	endFrom          string
	endTo            string
	compared         int
	endIDs           []int64
	endByFund        map[*insightsFund]*shortsstore.FundSnapshotRow
	startByFund      map[*insightsFund]*shortsstore.FundSnapshotRow
	superFrom        string
	superTo          string
}

const windowGroup int32 = -1

func widen(lo, hi *string, d string) {
	if *lo == "" || d < *lo {
		*lo = d
	}
	if d > *hi {
		*hi = d
	}
}

func (b *insightsBase) pairsFor(q insightsQuery, buckets []*shortsv1alpha1.InsightBucket) windowPairs {
	w := windowPairs{
		windowPairByFund: map[*insightsFund]shortsstore.FundSnapshotPair{},
		bucketFunds:      make([]int, len(buckets)),
		endByFund:        map[*insightsFund]*shortsstore.FundSnapshotRow{},
		startByFund:      map[*insightsFund]*shortsstore.FundSnapshotRow{},
	}
	if q.to == "" {
		return w
	}
	for _, f := range b.funds {
		end := f.at(q.to)
		if end == nil {
			continue
		}
		w.endIDs = append(w.endIDs, end.ID)
		w.endByFund[f] = end
		if f.sourceKind != "etf" {
			widen(&w.superFrom, &w.superTo, end.AsAt)
			continue
		}
		widen(&w.endFrom, &w.endTo, end.AsAt)
		start := f.startIn(q.from, q.to)
		if start == nil || start.AsAt >= end.AsAt {
			continue
		}
		w.startByFund[f] = start
		w.compared++
		widen(&w.startFrom, &w.startTo, start.AsAt)
		p := shortsstore.FundSnapshotPair{Group: windowGroup, From: start.ID, To: end.ID}
		w.pairs = append(w.pairs, p)
		w.windowPairByFund[f] = p
		prev := start
		for k, bk := range buckets {
			cur := f.at(bk.End)
			if cur == nil || cur.AsAt <= prev.AsAt {
				continue
			}
			w.pairs = append(w.pairs, shortsstore.FundSnapshotPair{Group: int32(k), From: prev.ID, To: cur.ID})
			w.bucketFunds[k]++
			prev = cur
		}
	}
	return w
}

// buildOwnershipInsights assembles one window's answer from the universe, the
// base and at most three fund reads (the end files, the changes, and the
// focused sector's institutions or stock's files).
func buildOwnershipInsights(ctx context.Context, u *ownershipUniverse, b *insightsBase, store insightsChangeReader, q insightsQuery) (*shortsv1alpha1.GetOwnershipInsightsResponse, error) {
	d := u.data
	bucketKind, buckets := insightBuckets(q.from, q.to)
	win := &shortsv1alpha1.InsightWindow{
		From: q.from, To: q.to, TimelineFrom: b.timelineFrom, TimelineTo: b.timelineTo,
		SnapshotDates: append([]string(nil), b.snapshotDates...),
		NoticesFrom:   b.noticesFrom, NoticesTo: b.noticesTo, NoticesAsOf: d.stats.LatestAnnounced,
		Bucket: bucketKind,
	}
	resp := &shortsv1alpha1.GetOwnershipInsightsResponse{
		Window:   win,
		Heatmap:  &shortsv1alpha1.InsightHeatmap{Buckets: buckets},
		Timeline: b.timeline,
	}
	if q.from == "" {
		resp.FlowFunds, resp.FlowDisclosed = &shortsv1alpha1.InsightFlow{}, &shortsv1alpha1.InsightFlow{}
		return resp, nil
	}

	wp := b.pairsFor(q, buckets)
	win.StartFilesFrom, win.StartFilesTo = wp.startFrom, wp.startTo
	win.EndFilesFrom, win.EndFilesTo = wp.endFrom, wp.endTo
	win.FundsCompared, win.FundsAtEnd = int32(wp.compared), int32(len(wp.endIDs))

	var endRows []shortsstore.FundSnapshotHoldingRow
	var changes []shortsstore.FundHoldingChangeRow
	if store != nil {
		var err error
		if endRows, err = store.FundSnapshotHoldings(ctx, wp.endIDs, ""); err != nil {
			return nil, err
		}
		if changes, err = store.FundHoldingChanges(ctx, wp.pairs, nil); err != nil {
			return nil, err
		}
	}

	sectorOf := func(code string) string { return insightSector(d.companies[code].Industry) }
	stocks := map[string]*stockAgg{}
	get := func(code string) *stockAgg {
		a := stocks[code]
		if a == nil {
			a = &stockAgg{code: code, sector: sectorOf(code)}
			stocks[code] = a
		}
		return a
	}

	// Holdings at the window's end, per stock, per institution.
	type instSector struct{ slug, sector string }
	fundFlowValue := map[instSector]float64{}
	for _, r := range endRows {
		f := b.fundBySnap[r.SnapshotID]
		if f == nil {
			continue
		}
		a := get(r.StockCode)
		if r.Value != nil {
			fundFlowValue[instSector{f.slug, a.sector}] += *r.Value
		}
		if f.sourceKind == "etf" {
			a.funds++
			if r.Value != nil {
				a.fundValue += *r.Value
				a.hasFundValue = true
			}
			if r.Units != nil {
				a.fundUnits += *r.Units
				a.hasFundUnits = true
			}
		} else if r.Value != nil {
			a.superValue += *r.Value
			a.hasSuperValue = true
		}
	}

	// The changes: the window per stock, the buckets per sector.
	type bucketSector struct {
		k      int
		sector string
	}
	bucketFlow := map[bucketSector]float64{}
	for _, r := range changes {
		flow, startAtEnd := changeFlow(r)
		if r.Group == windowGroup {
			a := get(r.StockCode)
			a.flow += flow
			a.startAtEnd += startAtEnd
			a.unitsFrom += r.UnitsFrom
			a.unitsTo += r.UnitsTo
			a.hasFlow = true
			a.hasUnitsFrom = a.hasUnitsFrom || r.HasUnitsFrom
			continue
		}
		bucketFlow[bucketSector{int(r.Group), sectorOf(r.StockCode)}] += flow
	}

	// The current register.
	for code, v := range u.views {
		if v.Holders == 0 {
			continue
		}
		a := get(code)
		a.disclosedPct = v.DisclosedPct
		for _, k := range v.ByKind {
			a.interests += int(k.Holders)
			if institutionalKinds[k.Kind] {
				a.investorInterests += int(k.Holders)
			}
		}
		if v.HasMarketCap && v.DisclosedPct > 0 {
			a.disclosedValue, a.hasDisclosedValue = v.DisclosedPct/100*v.MarketCap, true
		}
	}

	// The window's notices, per stock and per bucket.
	type bucketNotices struct {
		k      int
		sector string
	}
	cellNotices := map[bucketNotices]*stockAgg{}
	var windowNotices []insightNotice
	lo := sort.Search(len(b.notices), func(i int) bool { return b.notices[i].date >= q.from })
	for i := lo; i < len(b.notices) && b.notices[i].date <= q.to; i++ {
		n := b.notices[i]
		windowNotices = append(windowNotices, n)
		a := get(n.row.StockCode)
		a.addNotice(n)
		k := sort.Search(len(buckets), func(j int) bool { return buckets[j].End >= n.date })
		if k < len(buckets) {
			key := bucketNotices{k, a.sector}
			if cellNotices[key] == nil {
				cellNotices[key] = &stockAgg{}
			}
			cellNotices[key].addNotice(n)
		}
	}
	win.NoticesInWindow = int32(len(windowNotices))

	// Sectors, over every stock.
	type sectorAgg struct {
		stockAgg
		stocks     int
		hasFlowAny bool
	}
	sectors := map[string]*sectorAgg{}
	for _, a := range stocks {
		s := sectors[a.sector]
		if s == nil {
			s = &sectorAgg{}
			s.sector = a.sector
			sectors[a.sector] = s
		}
		if a.hasFundValue || a.interests > 0 || a.hasSuperValue {
			s.stocks++
		}
		if a.hasFundValue {
			s.fundValue += a.fundValue
			s.hasFundValue = true
		}
		if a.hasSuperValue {
			s.superValue += a.superValue
			s.hasSuperValue = true
		}
		if a.hasFlow {
			s.flow += a.flow
			s.startAtEnd += a.startAtEnd
			s.hasFlowAny = true
		}
		if a.hasDisclosedValue {
			s.disclosedValue += a.disclosedValue
			s.hasDisclosedValue = true
		}
		s.interests += a.interests
		s.investorInterests += a.investorInterests
		s.netPP += a.netPP
		s.notices += a.notices
		s.rises += a.rises
		s.falls += a.falls
		s.became += a.became
		s.ceased += a.ceased
	}
	sectorNames := make([]string, 0, len(sectors))
	for name, s := range sectors {
		if s.stocks == 0 && s.notices == 0 {
			continue
		}
		sectorNames = append(sectorNames, name)
	}
	sort.Slice(sectorNames, func(i, j int) bool {
		si, sj := sectors[sectorNames[i]], sectors[sectorNames[j]]
		if si.fundValue != sj.fundValue {
			return si.fundValue > sj.fundValue
		}
		if si.disclosedValue != sj.disclosedValue {
			return si.disclosedValue > sj.disclosedValue
		}
		return sectorNames[i] < sectorNames[j]
	})
	for _, name := range sectorNames {
		s := sectors[name]
		out := &shortsv1alpha1.InsightSector{
			Sector: name, Stocks: int32(s.stocks), Interests: int32(s.interests), InvestorInterests: int32(s.investorInterests),
			NoticeNetPp: roundTo(s.netPP, 4), Notices: int32(s.notices), Rises: int32(s.rises), Falls: int32(s.falls),
			Became: int32(s.became), Ceased: int32(s.ceased),
		}
		if s.hasFundValue {
			out.FundValueAud, out.HasFundValue = s.fundValue, true
		}
		if s.hasSuperValue {
			out.SuperValueAud, out.HasSuperValue = s.superValue, true
		}
		if s.hasFlowAny {
			out.FundFlowAud, out.HasFundFlow = s.flow, true
			if s.startAtEnd > 0 {
				out.FundChangePct, out.HasFundChange = roundTo(s.flow/s.startAtEnd*100, 4), true
			}
		}
		if s.hasDisclosedValue {
			out.DisclosedValueAud, out.HasDisclosedValue = s.disclosedValue, true
		}
		resp.Sectors = append(resp.Sectors, out)
	}

	// The heatmap: one row per sector, one cell per bucket.
	for _, name := range sectorNames {
		row := &shortsv1alpha1.InsightHeatRow{Sector: name}
		active := false
		for k := range buckets {
			cell := &shortsv1alpha1.InsightHeatCell{FundsCompared: int32(wp.bucketFunds[k])}
			if flow, ok := bucketFlow[bucketSector{k, name}]; ok && wp.bucketFunds[k] > 0 {
				cell.FundFlowAud, cell.HasFundFlow = flow, true
				active = true
			}
			if c := cellNotices[bucketNotices{k, name}]; c != nil {
				cell.NoticeNetPp, cell.Notices = roundTo(c.netPP, 4), int32(c.notices)
				cell.Rises, cell.Falls, cell.Became, cell.Ceased = int32(c.rises), int32(c.falls), int32(c.became), int32(c.ceased)
				active = true
			}
			row.Cells = append(row.Cells, cell)
		}
		if active {
			resp.Heatmap.Rows = append(resp.Heatmap.Rows, row)
		}
	}

	// The stocks: the largest by either measure, or every stock of the focused
	// sector, and the rest of each sector.
	all := make([]*stockAgg, 0, len(stocks))
	for _, a := range stocks {
		if a.hasFundValue || a.hasDisclosedValue || a.notices > 0 {
			all = append(all, a)
		}
	}
	resp.StocksTotal = int32(len(all))
	keep := map[string]bool{}
	if q.sector != "" || len(all) <= insightsStockCap {
		for _, a := range all {
			if q.sector == "" || a.sector == q.sector {
				keep[a.code] = true
			}
		}
	} else {
		for _, measure := range []func(*stockAgg) float64{
			func(a *stockAgg) float64 { return a.fundValue },
			func(a *stockAgg) float64 { return a.disclosedValue },
		} {
			ranked := append([]*stockAgg(nil), all...)
			sort.Slice(ranked, func(i, j int) bool {
				mi, mj := measure(ranked[i]), measure(ranked[j])
				if mi != mj {
					return mi > mj
				}
				return ranked[i].code < ranked[j].code
			})
			for i := 0; i < len(ranked) && i < insightsStockCap; i++ {
				if measure(ranked[i]) > 0 {
					keep[ranked[i].code] = true
				}
			}
		}
	}
	remainders := map[string]*shortsv1alpha1.InsightStockRemainder{}
	for _, a := range all {
		if keep[a.code] {
			resp.Stocks = append(resp.Stocks, stockProto(d, a))
			continue
		}
		if q.sector != "" {
			continue
		}
		r := remainders[a.sector]
		if r == nil {
			r = &shortsv1alpha1.InsightStockRemainder{Sector: a.sector}
			remainders[a.sector] = r
		}
		r.Stocks++
		r.FundValueAud += a.fundValue
		r.DisclosedValueAud += a.disclosedValue
	}
	sort.Slice(resp.Stocks, func(i, j int) bool {
		if resp.Stocks[i].FundValueAud != resp.Stocks[j].FundValueAud {
			return resp.Stocks[i].FundValueAud > resp.Stocks[j].FundValueAud
		}
		if resp.Stocks[i].DisclosedValueAud != resp.Stocks[j].DisclosedValueAud {
			return resp.Stocks[i].DisclosedValueAud > resp.Stocks[j].DisclosedValueAud
		}
		return resp.Stocks[i].StockCode < resp.Stocks[j].StockCode
	})
	for _, name := range sectorNames {
		if r := remainders[name]; r != nil {
			resp.Remainders = append(resp.Remainders, r)
		}
	}

	// The money flow.
	insts := d.institutionBySlug()
	var fundLinks []flowEdge
	for k, v := range fundFlowValue {
		if v <= 0 {
			continue
		}
		inst := insts[k.slug]
		kind := inst.Kind
		if kind == "" {
			kind = "other"
		}
		name := inst.Name
		if name == "" {
			name = k.slug
		}
		fundLinks = append(fundLinks, flowEdge{kind: kind, holder: "inst:" + k.slug, label: name, slug: k.slug, sector: k.sector, value: v})
	}
	resp.FlowFunds = buildInsightFlow(fundLinks)
	resp.FlowFunds.AsAtFrom, resp.FlowFunds.AsAtTo = minNonEmpty(wp.endFrom, wp.superFrom), max(wp.endTo, wp.superTo)
	var disclosedLinks []flowEdge
	for _, h := range countedHoldings(d.holdings, d.groups()) {
		c := d.companies[h.StockCode]
		if c.MarketCap == nil || *c.MarketCap <= 0 || h.PresentPct <= 0 {
			continue
		}
		holder, label, slug := "key:"+h.HolderKey, h.HolderName, ""
		if h.InstitutionSlug != "" {
			holder, slug = "inst:"+h.InstitutionSlug, h.InstitutionSlug
			if inst, ok := insts[h.InstitutionSlug]; ok && inst.Name != "" {
				label = inst.Name
			}
		}
		if label == "" {
			label = h.HolderKey
		}
		disclosedLinks = append(disclosedLinks, flowEdge{kind: h.Kind, holder: holder, label: label, slug: slug,
			sector: insightSector(c.Industry), value: h.PresentPct / 100 * *c.MarketCap})
	}
	resp.FlowDisclosed = buildInsightFlow(disclosedLinks)
	resp.FlowDisclosed.AsAtTo = d.stats.LatestAnnounced

	// The window's largest stated moves.
	var moves []insightNotice
	for _, n := range windowNotices {
		if n.hasDelta && n.delta != 0 && (q.sector == "" || sectorOf(n.row.StockCode) == q.sector) {
			moves = append(moves, n)
		}
	}
	sort.SliceStable(moves, func(i, j int) bool {
		ai, aj := math.Abs(moves[i].delta), math.Abs(moves[j].delta)
		if ai != aj {
			return ai > aj
		}
		return moves[i].date > moves[j].date
	})
	for i := 0; i < len(moves) && i < insightsMoves; i++ {
		resp.Moves = append(resp.Moves, d.noticeProto(moves[i].row))
	}

	if q.sector != "" && store != nil {
		flows, err := sectorInstitutions(ctx, store, d, b, wp, endRows, q.sector, sectorOf)
		if err != nil {
			return nil, err
		}
		resp.SectorInstitutions = flows
	}
	if q.stockCode != "" {
		detail, err := stockDetail(ctx, store, u, b, wp, windowNotices, q.stockCode, sectorOf)
		if err != nil {
			return nil, err
		}
		resp.StockDetail = detail
	}
	return resp, nil
}

func minNonEmpty(a, b string) string {
	switch {
	case a == "":
		return b
	case b == "":
		return a
	case a < b:
		return a
	default:
		return b
	}
}

func stockProto(d *ownershipData, a *stockAgg) *shortsv1alpha1.InsightStock {
	c := d.companies[a.code]
	out := &shortsv1alpha1.InsightStock{
		StockCode: a.code, CompanyName: c.Name, Sector: a.sector, Funds: int32(a.funds),
		DisclosedPct: roundTo(a.disclosedPct, 4), Interests: int32(a.interests),
		NoticeNetPp: roundTo(a.netPP, 4), Notices: int32(a.notices),
	}
	if a.hasFundValue {
		out.FundValueAud, out.HasFundValue = a.fundValue, true
	}
	if a.hasFlow {
		out.FundFlowAud, out.HasFundFlow = a.flow, true
		if a.unitsFrom > 0 {
			out.FundChangePct, out.HasFundChange = roundTo((a.unitsTo-a.unitsFrom)/a.unitsFrom*100, 4), true
		}
	}
	if a.hasFundUnits {
		if sp, ok := d.shorts[a.code]; ok && sp.Issued > 0 {
			out.IndexPct, out.HasIndexPct = roundTo(a.fundUnits/sp.Issued*100, 4), true
		}
	}
	if a.hasDisclosedValue {
		out.DisclosedValueAud, out.HasDisclosedValue = a.disclosedValue, true
	}
	if c.MarketCap != nil && *c.MarketCap > 0 {
		out.MarketCap, out.HasMarketCap = *c.MarketCap, true
	}
	return out
}

// flowEdge is one holder's value in one sector, before the Sankey folds the
// tail into Other.
type flowEdge struct {
	kind, holder, label, slug, sector string
	value                             float64
}

const (
	flowOtherHolder = "other"
	flowOtherSector = "sector:other"
)

// buildInsightFlow folds edges into a three-column Sankey: kind, holder (the
// largest insightsFlowInstitutions, the rest "Other"), sector (the largest
// insightsFlowSectors, the rest "Other sectors").
func buildInsightFlow(edges []flowEdge) *shortsv1alpha1.InsightFlow {
	out := &shortsv1alpha1.InsightFlow{}
	if len(edges) == 0 {
		return out
	}
	holderTotal := map[string]float64{}
	holderInfo := map[string]flowEdge{}
	sectorTotal := map[string]float64{}
	for _, e := range edges {
		holderTotal[e.holder] += e.value
		sectorTotal[e.sector] += e.value
		if _, ok := holderInfo[e.holder]; !ok {
			holderInfo[e.holder] = e
		}
		out.TotalAud += e.value
	}
	top := func(totals map[string]float64, n int) map[string]bool {
		keys := make([]string, 0, len(totals))
		for k := range totals {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool {
			if totals[keys[i]] != totals[keys[j]] {
				return totals[keys[i]] > totals[keys[j]]
			}
			return keys[i] < keys[j]
		})
		kept := map[string]bool{}
		for i := 0; i < len(keys) && i < n; i++ {
			kept[keys[i]] = true
		}
		return kept
	}
	keptHolders := top(holderTotal, insightsFlowInstitutions)
	keptSectors := top(sectorTotal, insightsFlowSectors)

	index := map[string]int32{}
	node := func(id string, mk func() *shortsv1alpha1.InsightFlowNode) int32 {
		if i, ok := index[id]; ok {
			return i
		}
		n := mk()
		n.Id = id
		index[id] = int32(len(out.Nodes))
		out.Nodes = append(out.Nodes, n)
		return index[id]
	}
	type linkKey struct{ s, t int32 }
	links := map[linkKey]float64{}
	for _, e := range edges {
		kindID := "kind:" + e.kind
		ki := node(kindID, func() *shortsv1alpha1.InsightFlowNode {
			return &shortsv1alpha1.InsightFlowNode{Label: e.kind, Column: 0, Kind: e.kind}
		})
		holderID, holderLabel, holderKind, holderSlug := flowOtherHolder, "Other", "", ""
		if keptHolders[e.holder] {
			info := holderInfo[e.holder]
			holderID, holderLabel, holderKind, holderSlug = e.holder, info.label, info.kind, info.slug
		}
		hi := node(holderID, func() *shortsv1alpha1.InsightFlowNode {
			return &shortsv1alpha1.InsightFlowNode{Label: holderLabel, Column: 1, Kind: holderKind, Slug: holderSlug}
		})
		sectorID, sector, sectorLabel := "sector:"+e.sector, e.sector, e.sector
		if !keptSectors[e.sector] {
			sectorID, sector, sectorLabel = flowOtherSector, "", "Other sectors"
		}
		si := node(sectorID, func() *shortsv1alpha1.InsightFlowNode {
			return &shortsv1alpha1.InsightFlowNode{Label: sectorLabel, Column: 2, Sector: sector}
		})
		out.Nodes[ki].ValueAud += e.value
		out.Nodes[hi].ValueAud += e.value
		out.Nodes[si].ValueAud += e.value
		links[linkKey{ki, hi}] += e.value
		links[linkKey{hi, si}] += e.value
	}
	for k, v := range links {
		out.Links = append(out.Links, &shortsv1alpha1.InsightFlowLink{Source: k.s, Target: k.t, ValueAud: v})
	}
	sort.Slice(out.Links, func(i, j int) bool {
		if out.Links[i].Source != out.Links[j].Source {
			return out.Links[i].Source < out.Links[j].Source
		}
		return out.Links[i].Target < out.Links[j].Target
	})
	return out
}

// sectorInstitutions is each institution's index fund and super option holdings
// in the focused sector at the window's end, and its index funds' change over
// the window: one read, grouped by institution.
func sectorInstitutions(ctx context.Context, store insightsChangeReader, d *ownershipData, b *insightsBase, wp windowPairs,
	endRows []shortsstore.FundSnapshotHoldingRow, sector string, sectorOf func(string) string) ([]*shortsv1alpha1.InsightInstitutionFlow, error) {
	var codes []string
	seen := map[string]bool{}
	value := map[string]float64{}
	hasValue := map[string]bool{}
	for _, r := range endRows {
		f := b.fundBySnap[r.SnapshotID]
		if f == nil || sectorOf(r.StockCode) != sector {
			continue
		}
		if !seen[r.StockCode] {
			seen[r.StockCode] = true
			codes = append(codes, r.StockCode)
		}
		if r.Value != nil {
			value[f.slug] += *r.Value
			hasValue[f.slug] = true
		}
	}
	slugs := []string{}
	slugIndex := map[string]int32{}
	var pairs []shortsstore.FundSnapshotPair
	for f, p := range wp.windowPairByFund {
		i, ok := slugIndex[f.slug]
		if !ok {
			i = int32(len(slugs))
			slugIndex[f.slug] = i
			slugs = append(slugs, f.slug)
		}
		pairs = append(pairs, shortsstore.FundSnapshotPair{Group: i, From: p.From, To: p.To})
	}
	flow := map[string]float64{}
	hasFlow := map[string]bool{}
	if len(pairs) > 0 && len(codes) > 0 {
		sort.Slice(pairs, func(i, j int) bool { return pairs[i].From < pairs[j].From })
		rows, err := store.FundHoldingChanges(ctx, pairs, codes)
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			slug := slugs[r.Group]
			f, _ := changeFlow(r)
			flow[slug] += f
			hasFlow[slug] = true
		}
	}
	insts := d.institutionBySlug()
	var out []*shortsv1alpha1.InsightInstitutionFlow
	for slug := range unionKeys(hasValue, hasFlow) {
		inst := insts[slug]
		name := inst.Name
		if name == "" {
			name = slug
		}
		row := &shortsv1alpha1.InsightInstitutionFlow{InstitutionSlug: slug, InstitutionName: name, Kind: inst.Kind}
		if hasValue[slug] {
			row.ValueAud, row.HasValue = value[slug], true
		}
		if hasFlow[slug] {
			row.FlowAud, row.HasFlow = flow[slug], true
		}
		out = append(out, row)
	}
	sort.Slice(out, func(i, j int) bool {
		fi, fj := math.Abs(out[i].FlowAud), math.Abs(out[j].FlowAud)
		if fi != fj {
			return fi > fj
		}
		if out[i].ValueAud != out[j].ValueAud {
			return out[i].ValueAud > out[j].ValueAud
		}
		return out[i].InstitutionSlug < out[j].InstitutionSlug
	})
	return out, nil
}

func unionKeys(a, b map[string]bool) map[string]bool {
	out := map[string]bool{}
	for k := range a {
		out[k] = true
	}
	for k := range b {
		out[k] = true
	}
	return out
}

// stockDetail is the focused stock: its register by kind, every fund file
// holding it at the window's end beside that fund's start file, and the
// window's notices for it. Nil for a code nothing on record names.
func stockDetail(ctx context.Context, store insightsChangeReader, u *ownershipUniverse, b *insightsBase, wp windowPairs,
	windowNotices []insightNotice, code string, sectorOf func(string) string) (*shortsv1alpha1.InsightStockDetail, error) {
	d := u.data
	c, known := d.companies[code]
	out := &shortsv1alpha1.InsightStockDetail{StockCode: code, CompanyName: c.Name, Sector: sectorOf(code)}
	if v, ok := u.views[code]; ok {
		known = true
		out.DisclosedPct, out.Holders, out.LatestNoticeDate = roundTo(v.DisclosedPct, 4), v.Holders, v.LatestNoticeDate
		for _, k := range v.ByKind {
			out.ByKind = append(out.ByKind, &shortsv1alpha1.KindShare{Kind: k.Kind, Pct: k.Pct, Holders: k.Holders})
		}
	}
	if store != nil && len(wp.endIDs) > 0 {
		ids := append([]int64(nil), wp.endIDs...)
		for _, s := range wp.startByFund {
			ids = append(ids, s.ID)
		}
		rows, err := store.FundSnapshotHoldings(ctx, ids, code)
		if err != nil {
			return nil, err
		}
		byID := map[int64]shortsstore.FundSnapshotHoldingRow{}
		for _, r := range rows {
			byID[r.SnapshotID] = r
		}
		insts := d.institutionBySlug()
		for f, end := range wp.endByFund {
			r, ok := byID[end.ID]
			if !ok {
				continue
			}
			known = true
			inst := insts[f.slug]
			p := &shortsv1alpha1.InsightFundPosition{
				InstitutionSlug: f.slug, InstitutionName: inst.Name, Kind: inst.Kind, FundName: f.name, FundCode: f.code,
				SourceKind: f.sourceKind, AsAt: end.AsAt,
			}
			if p.InstitutionName == "" {
				p.InstitutionName = f.slug
			}
			if r.Units != nil {
				p.Units, p.HasUnits = *r.Units, true
			}
			if r.Value != nil {
				p.ValueAud, p.HasValue = *r.Value, true
			}
			if start, ok := wp.startByFund[f]; ok {
				p.StartAsAt = start.AsAt
				if sr, ok := byID[start.ID]; ok && sr.Units != nil {
					p.StartUnits, p.HasStartUnits = *sr.Units, true
				} else if !ok {
					// The fund's start file does not hold the stock: a new position.
					p.StartUnits, p.HasStartUnits = 0, true
				}
			}
			out.Funds = append(out.Funds, p)
		}
		sort.Slice(out.Funds, func(i, j int) bool {
			if out.Funds[i].ValueAud != out.Funds[j].ValueAud {
				return out.Funds[i].ValueAud > out.Funds[j].ValueAud
			}
			return out.Funds[i].InstitutionSlug+out.Funds[i].FundName < out.Funds[j].InstitutionSlug+out.Funds[j].FundName
		})
	}
	for i := len(windowNotices) - 1; i >= 0 && len(out.Notices) < insightsDetailNotices; i-- {
		if windowNotices[i].row.StockCode == code {
			known = true
			out.Notices = append(out.Notices, d.noticeProto(windowNotices[i].row))
		}
	}
	if !known {
		return nil, nil
	}
	return out, nil
}
