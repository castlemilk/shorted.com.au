package shorts

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"google.golang.org/protobuf/proto"
)

// The explorer's two list rpcs. ListSubstantialNotices pages the notices table
// through the store, one keyset read a page. A first page's read is cached beside
// the universe, keyed by its generation and clamped query, and the response is
// assembled from it per request, so no entry carries the universe's as-of date or
// company names. ListStockRegisters filters and sorts the universe in memory,
// which is cheap enough to run per request, so the universe is its only cache.
// The clamps are the contract the web mirrors (web/src/@/lib/ownership), pinned by
// web/src/@/lib/ownership/__fixtures__/clamps.json.

// noticeWindows are the windows the feed serves, in days. Window 0 is every
// notice the store holds: it has no date clause, so a stock's total is the
// history count its stock page reports.
var noticeWindows = []int32{7, 30, 90, 365}

// noticeActivityMaxWindow is the widest window that carries activity: its weekly
// buckets and largest moves. A longer window answers with the list alone.
const noticeActivityMaxWindow = 90

// The vocabularies the requests are validated against. holderKinds covers every
// kind holderKindSQL reports: the institution kinds, corporate and unclassified.
var (
	noticeEvents = []string{shortsstore.EventBecame, shortsstore.EventIncreased, shortsstore.EventDecreased,
		shortsstore.EventChanged, shortsstore.EventCeased, shortsstore.EventNZ}
	holderKinds = []string{"super_fund", "index_manager", "active_manager", "hedge_fund", "bank_broker",
		"sovereign_public", "insurer", "private_equity", "corporate", "other", "unclassified"}
	registerSorts = []string{"disclosed", "investors", "banks", "hedge_active", "short", "index",
		"super_value", "super_options", "interests", "latest_notice", "code"}
)

const (
	defaultRegisterSort = "disclosed"
	// pageDefaultLimit is what a limit of 0 (or below) means; pageMaxLimit is the
	// most a page serves.
	pageDefaultLimit = 50
	pageMaxLimit     = 100
	// registerMaxOffset is the deepest offset the register list serves.
	registerMaxOffset = 5000
	// registerMaxQuery is the longest query the register list takes, in characters.
	registerMaxQuery = 24
	// registerKindMinPct is the disclosure a kind must reach in a stock to pass the
	// kind filter.
	registerKindMinPct = 5.0
)

var (
	ownershipCodeRegex       = regexp.MustCompile(`^[A-Z0-9]{1,6}$`)
	errInvalidNoticeCursor   = errors.New("cursor must be the previous page's next_cursor, YYYY-MM-DD|announcement_url")
	errNoticeWindowNegative  = errors.New("window_days must not be negative")
	errRegisterOffsetOutside = fmt.Errorf("offset must be between 0 and %d", registerMaxOffset)
)

// servedNoticeWindow rounds a requested window up to the next served one. Zero
// and anything above the widest window are the whole register, which is 0; a
// negative window is an error.
func servedNoticeWindow(days int32) (int32, error) {
	if days < 0 {
		return 0, errNoticeWindowNegative
	}
	for _, w := range noticeWindows {
		if days > 0 && days <= w {
			return w, nil
		}
	}
	return 0, nil
}

// noticeSince is the first release date in a window ending today, or "" for
// window 0, which has no date clause.
func noticeSince(window int32, today time.Time) string {
	if window == 0 {
		return ""
	}
	return today.AddDate(0, 0, -int(window)).Format(time.DateOnly)
}

// pageLimit clamps a page's limit: 0 and below mean the default, and anything
// above the maximum is the maximum.
func pageLimit(limit int32) int {
	switch {
	case limit <= 0:
		return pageDefaultLimit
	case limit > pageMaxLimit:
		return pageMaxLimit
	}
	return int(limit)
}

// snapShortPct snaps a minimum short position down to a served step: 0, 1, 3, 5
// or 10. Anything below 1, negative, and NaN, filters nothing.
func snapShortPct(pct float64) float64 {
	for _, step := range []float64{10, 5, 3, 1} {
		if pct >= step {
			return step
		}
	}
	return 0
}

// lowerTrim normalises a vocabulary word from a request.
func lowerTrim(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

// noticeCursor is a page's last notice, as the next page's cursor. The release
// date orders the feed and the announcement URL, the primary key, breaks its
// ties, so the pair orders every notice. The URL may contain a "|"; the date
// never does, so the cursor splits at the first one.
func noticeCursor(announcedOn, announcementURL string) string {
	return announcedOn + "|" + announcementURL
}

// noticeCursorEarliest is the oldest release date a cursor may name. The register
// holds no notice that old, and year 0000 is no date Postgres accepts, so an
// earlier cursor is refused here as InvalidArgument, not by the query.
var noticeCursorEarliest = time.Date(2000, time.January, 1, 0, 0, 0, 0, time.UTC)

// parseNoticeCursor reads a cursor back: a release date no earlier than
// noticeCursorEarliest, and a non-empty URL.
func parseNoticeCursor(cursor string) (string, string, error) {
	date, url, ok := strings.Cut(cursor, "|")
	if !ok || url == "" {
		return "", "", errInvalidNoticeCursor
	}
	day, err := time.Parse(time.DateOnly, date)
	if err != nil || day.Before(noticeCursorEarliest) {
		return "", "", errInvalidNoticeCursor
	}
	return date, url, nil
}

// noticeFeedQuery is ListSubstantialNoticesRequest after its clamps. The registry
// check on the institution needs the universe, so the handler makes it.
type noticeFeedQuery struct {
	window          int32
	event           string
	kind            string
	stockCode       string
	institutionSlug string
	cursorDate      string
	cursorURL       string
	limit           int
	includeActivity bool
}

func parseNoticeFeedQuery(m *shortsv1alpha1.ListSubstantialNoticesRequest) (noticeFeedQuery, error) {
	var q noticeFeedQuery
	window, err := servedNoticeWindow(m.WindowDays)
	if err != nil {
		return q, err
	}
	q.window = window
	q.event = lowerTrim(m.Event)
	if q.event != "" && !slices.Contains(noticeEvents, q.event) {
		return q, fmt.Errorf("event must be one of %s, got %q", strings.Join(noticeEvents, ", "), m.Event)
	}
	q.kind = lowerTrim(m.Kind)
	if q.kind != "" && !slices.Contains(holderKinds, q.kind) {
		return q, fmt.Errorf("kind %q is not a holder kind", m.Kind)
	}
	q.stockCode = strings.ToUpper(strings.TrimSpace(m.StockCode))
	if q.stockCode != "" && !ownershipCodeRegex.MatchString(q.stockCode) {
		return q, fmt.Errorf("stock_code %q is not 1 to 6 letters or digits", m.StockCode)
	}
	q.institutionSlug = lowerTrim(m.InstitutionSlug)
	if m.Cursor != "" {
		if q.cursorDate, q.cursorURL, err = parseNoticeCursor(m.Cursor); err != nil {
			return q, err
		}
	}
	q.limit = pageLimit(m.Limit)
	q.includeActivity = m.IncludeActivity
	return q, nil
}

// filter is the store's filter for the query, its window measured back from today.
// A registry slug filters on the holder key: the job keys an institution's
// notices by its slug, and the institution page reads them by that same key.
func (q noticeFeedQuery) filter(today time.Time) shortsstore.NoticeFilter {
	return shortsstore.NoticeFilter{
		Since: noticeSince(q.window, today), Event: q.event, Kind: q.kind,
		StockCode: q.stockCode, HolderKey: q.institutionSlug,
	}
}

// wantsActivity reports whether the response carries the window's activity: a
// first page of a window that allows it. A page after a cursor never does, so it
// reads none.
func (q noticeFeedQuery) wantsActivity() bool {
	return q.includeActivity && q.cursorDate == "" && q.window > 0 && q.window <= noticeActivityMaxWindow
}

// noticeFeedRead is one read of the feed, all of it from the store: the rows a
// page is cut from (one more than the page, whose presence says another page
// follows), the window's total and, when the page carries it, the window's
// activity. It is taken at today, the day the window is measured back from.
type noticeFeedRead struct {
	today    time.Time
	rows     []shortsstore.SubstantialNoticeRow
	total    int
	activity *shortsstore.NoticeActivityRows
}

// readNoticeFeed reads one page of the feed from the store.
func (s *ShortsServer) readNoticeFeed(ctx context.Context, q noticeFeedQuery, today time.Time) (noticeFeedRead, error) {
	f := q.filter(today)
	read := noticeFeedRead{today: today}
	var err error
	// One row more than the page: its presence says another page follows.
	if read.rows, err = s.ownershipStore.SubstantialNoticesPage(ctx, f, q.cursorDate, q.cursorURL, q.limit+1); err != nil {
		return read, err
	}
	if read.total, err = s.ownershipStore.CountSubstantialNotices(ctx, f); err != nil {
		return read, err
	}
	if q.wantsActivity() {
		activity, err := s.ownershipStore.NoticeActivity(ctx, f)
		if err != nil {
			return read, err
		}
		read.activity = &activity
	}
	return read, nil
}

// noticeFeedResponse assembles a page from its read against the universe. The
// as-of date and each notice's company name are the universe's as it is now, so
// no cached read carries an older universe's.
func (u *ownershipUniverse) noticeFeedResponse(q noticeFeedQuery, read noticeFeedRead) *shortsv1alpha1.ListSubstantialNoticesResponse {
	out := &shortsv1alpha1.ListSubstantialNoticesResponse{
		WindowDays: q.window, AsOf: u.data.stats.LatestAnnounced, Total: int32(read.total),
	}
	rows := read.rows
	if len(rows) > q.limit {
		rows = rows[:q.limit]
		last := rows[len(rows)-1]
		out.NextCursor = noticeCursor(last.AnnouncedOn, last.AnnouncementURL)
	}
	for _, r := range rows {
		out.Notices = append(out.Notices, u.data.noticeProto(r))
	}
	if read.activity != nil {
		out.Activity = u.data.buildNoticeActivity(*read.activity, q.window, read.today)
	}
	return out
}

// ListSubstantialNotices pages the notices feed, newest release first. A first
// page's read is cached beside the universe it was made under: the key names the
// generation, and the entry lives no longer than that universe does. A cursor
// page is read through, since its cursor makes it a query of its own.
func (s *ShortsServer) ListSubstantialNotices(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.ListSubstantialNoticesRequest],
) (*connect.Response[shortsv1alpha1.ListSubstantialNoticesResponse], error) {
	q, err := parseNoticeFeedQuery(req.Msg)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	if s.ownershipStore == nil {
		return connect.NewResponse(&shortsv1alpha1.ListSubstantialNoticesResponse{WindowDays: q.window}), nil
	}
	u, err := s.ownershipUniverse.get(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("list substantial notices: %w", err))
	}
	if q.institutionSlug != "" {
		if _, ok := u.data.institutionBySlug()[q.institutionSlug]; !ok {
			return nil, connect.NewError(connect.CodeInvalidArgument,
				fmt.Errorf("institution_slug %q is not in the registry", q.institutionSlug))
		}
	}
	today := s.ownershipUniverse.now().UTC()
	if q.cursorDate != "" {
		read, err := s.readNoticeFeed(ctx, q, today)
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("list substantial notices: %w", err))
		}
		return connect.NewResponse(u.noticeFeedResponse(q, read)), nil
	}
	key := s.cache.ListSubstantialNoticesKey(u.generation, q.window, q.event, q.kind, q.stockCode,
		q.institutionSlug, int32(q.limit), q.includeActivity)
	v, err := s.cache.GetOrSetWithTTL(key, u.ttlRemaining(), func() (any, error) {
		// The cache shares this read with every caller of the key, so the caller
		// that started it may leave.
		read, err := s.readNoticeFeed(context.WithoutCancel(ctx), q, today)
		if err != nil {
			return nil, err
		}
		return read, nil
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("list substantial notices: %w", err))
	}
	return connect.NewResponse(u.noticeFeedResponse(q, v.(noticeFeedRead))), nil
}

// buildNoticeActivity is a window's activity: the event totals, one NoticeWeek a
// Monday from the window's first week through the newest (empty weeks included,
// oldest first), and the largest moves. A notice dated after today still gets
// its week, so the weeks always cover every row.
func (d *ownershipData) buildNoticeActivity(rows shortsstore.NoticeActivityRows, window int32, today time.Time) *shortsv1alpha1.NoticeActivity {
	byWeek := make(map[string]shortsstore.NoticeWeekRow, len(rows.Weeks))
	last := mondayOf(today)
	for _, w := range rows.Weeks {
		byWeek[w.WeekStart] = w
		if day, err := time.Parse(time.DateOnly, w.WeekStart); err == nil && day.After(last) {
			last = day
		}
	}
	out := &shortsv1alpha1.NoticeActivity{}
	for week := mondayOf(today.AddDate(0, 0, -int(window))); !week.After(last); week = week.AddDate(0, 0, 7) {
		start := week.Format(time.DateOnly)
		w := byWeek[start]
		out.Weeks = append(out.Weeks, &shortsv1alpha1.NoticeWeek{
			WeekStart: start, Became: int32(w.Became), Increased: int32(w.Increased), Decreased: int32(w.Decreased),
			Changed: int32(w.Changed), Ceased: int32(w.Ceased), Nz: int32(w.NZ),
		})
		out.Became += int32(w.Became)
		out.Increased += int32(w.Increased)
		out.Decreased += int32(w.Decreased)
		out.Changed += int32(w.Changed)
		out.Ceased += int32(w.Ceased)
		out.Nz += int32(w.NZ)
	}
	for _, r := range rows.Rises {
		out.LargestRises = append(out.LargestRises, d.noticeProto(r))
	}
	for _, r := range rows.Falls {
		out.LargestFalls = append(out.LargestFalls, d.noticeProto(r))
	}
	return out
}

// mondayOf is the Monday that starts t's ISO week, at UTC midnight.
func mondayOf(t time.Time) time.Time {
	y, m, d := t.UTC().Date()
	day := time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
	return day.AddDate(0, 0, -((int(day.Weekday()) + 6) % 7))
}

// registerQuery is ListStockRegistersRequest after its clamps.
type registerQuery struct {
	sort         string
	ascending    bool
	industry     string
	kind         string
	minInterests int
	minShortPct  float64
	// codePrefix and nameSubstring are the query, trimmed, in the case each match
	// uses: a code prefix upper case, a name substring lower case.
	codePrefix    string
	nameSubstring string
	limit         int
	offset        int
}

func parseRegisterQuery(m *shortsv1alpha1.ListStockRegistersRequest) (registerQuery, error) {
	var q registerQuery
	q.sort = lowerTrim(m.Sort)
	if q.sort == "" {
		q.sort = defaultRegisterSort
	}
	if !slices.Contains(registerSorts, q.sort) {
		return q, fmt.Errorf("sort must be one of %s, got %q", strings.Join(registerSorts, ", "), m.Sort)
	}
	q.ascending = m.Ascending
	q.industry = strings.TrimSpace(m.Industry)
	q.kind = lowerTrim(m.Kind)
	if q.kind != "" && !slices.Contains(holderKinds, q.kind) {
		return q, fmt.Errorf("kind %q is not a holder kind", m.Kind)
	}
	q.minInterests = max(int(m.MinInterests), 1)
	q.minShortPct = snapShortPct(m.MinShortPct)
	query := strings.TrimSpace(m.Query)
	if utf8.RuneCountInString(query) > registerMaxQuery {
		return q, fmt.Errorf("query must be at most %d characters", registerMaxQuery)
	}
	q.codePrefix = strings.ToUpper(query)
	q.nameSubstring = strings.ToLower(query)
	if m.Offset < 0 || m.Offset > registerMaxOffset {
		return q, errRegisterOffsetOutside
	}
	q.limit = pageLimit(m.Limit)
	q.offset = int(m.Offset)
	return q, nil
}

// interestCount is a stock's counted interests: the holders its by-kind figures
// count, each interest once.
func interestCount(v *shortsv1alpha1.OwnershipStock) int {
	n := 0
	for _, ks := range v.ByKind {
		n += int(ks.Holders)
	}
	return n
}

// matches reports whether a stock passes every filter the query sets.
func (q registerQuery) matches(v *shortsv1alpha1.OwnershipStock) bool {
	if q.industry != "" && v.Industry != q.industry {
		return false
	}
	if q.kind != "" && kindPct(v, q.kind) < registerKindMinPct {
		return false
	}
	if interestCount(v) < q.minInterests {
		return false
	}
	if q.minShortPct > 0 && (!v.HasShortPct || v.ShortPct < q.minShortPct) {
		return false
	}
	if q.codePrefix != "" && !strings.HasPrefix(v.StockCode, q.codePrefix) &&
		!strings.Contains(strings.ToLower(v.CompanyName), q.nameSubstring) {
		return false
	}
	return true
}

// registerValue is one stock's value under a sort key. A stock without the
// figure is unknown and sorts last, whatever the direction.
type registerValue struct {
	known bool
	num   float64
	text  string
}

// registerSortValue is a stock's value under the sort key.
func registerSortValue(sortKey string, v *shortsv1alpha1.OwnershipStock) registerValue {
	number := func(known bool, n float64) registerValue { return registerValue{known: known, num: n} }
	switch sortKey {
	case "investors":
		return number(true, institutionalPct(v))
	case "banks":
		return number(true, kindPct(v, "bank_broker"))
	case "hedge_active":
		return number(true, kindPct(v, "hedge_fund", "active_manager"))
	case "short":
		return number(v.HasShortPct, v.ShortPct)
	case "index":
		return number(v.HasIndexPct, v.IndexPct)
	case "super_value":
		return number(v.HasSuperValue, v.SuperValueAud)
	case "super_options":
		return number(true, float64(v.SuperOptions))
	case "interests":
		return number(true, float64(interestCount(v)))
	case "latest_notice":
		return registerValue{known: v.LatestNoticeDate != "", text: v.LatestNoticeDate}
	case "code":
		return registerValue{known: true, text: v.StockCode}
	default:
		return number(true, v.DisclosedPct)
	}
}

// compareRegisterValues is -1, 0 or 1: by number, then by text.
func compareRegisterValues(a, b registerValue) int {
	switch {
	case a.num < b.num:
		return -1
	case a.num > b.num:
		return 1
	case a.text < b.text:
		return -1
	case a.text > b.text:
		return 1
	}
	return 0
}

// less orders two stocks: by the sort key in its direction, unknowns last, and
// ties by code.
func (q registerQuery) less(a, b *shortsv1alpha1.OwnershipStock) bool {
	va, vb := registerSortValue(q.sort, a), registerSortValue(q.sort, b)
	if va.known != vb.known {
		return va.known
	}
	if va.known {
		if c := compareRegisterValues(va, vb); c != 0 {
			return (c < 0) == q.ascending
		}
	}
	return a.StockCode < b.StockCode
}

// registerUniverse is the stocks with at least one current holder: the register
// list's universe, before any filter.
func registerUniverse(u *ownershipUniverse) []*shortsv1alpha1.OwnershipStock {
	var out []*shortsv1alpha1.OwnershipStock
	for _, v := range u.views {
		if v.Holders > 0 {
			out = append(out, v)
		}
	}
	return out
}

// industryCounts is the distinct industries of the stocks, sorted, each with the
// number of stocks in it. A stock with no industry is in none.
func industryCounts(stocks []*shortsv1alpha1.OwnershipStock) []*shortsv1alpha1.IndustryCount {
	counts := map[string]int32{}
	for _, v := range stocks {
		if v.Industry != "" {
			counts[v.Industry]++
		}
	}
	out := make([]*shortsv1alpha1.IndustryCount, 0, len(counts))
	for name, n := range counts {
		out = append(out, &shortsv1alpha1.IndustryCount{Industry: name, Stocks: n})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Industry < out[j].Industry })
	return out
}

// buildStockRegisters is the register list: the universe, filtered, sorted and
// paged. Every stock in the page is a copy of its view. An industry outside the
// universe's is an error.
func buildStockRegisters(u *ownershipUniverse, q registerQuery) (*shortsv1alpha1.ListStockRegistersResponse, error) {
	universe := registerUniverse(u)
	industries := industryCounts(universe)
	if q.industry != "" && !slices.ContainsFunc(industries, func(c *shortsv1alpha1.IndustryCount) bool {
		return c.Industry == q.industry
	}) {
		return nil, fmt.Errorf("industry %q is not one of the register's industries", q.industry)
	}
	out := &shortsv1alpha1.ListStockRegistersResponse{
		Universe: int32(len(universe)), Industries: industries, AsOf: u.data.stats.LatestAnnounced,
	}
	var matched []*shortsv1alpha1.OwnershipStock
	for _, v := range universe {
		if q.matches(v) {
			matched = append(matched, v)
		}
	}
	sort.Slice(matched, func(i, j int) bool { return q.less(matched[i], matched[j]) })
	out.Total = int32(len(matched))
	page := matched[min(q.offset, len(matched)):min(q.offset+q.limit, len(matched))]
	for _, v := range page {
		out.Stocks = append(out.Stocks, proto.Clone(v).(*shortsv1alpha1.OwnershipStock))
	}
	return out, nil
}

// ListStockRegisters is the register list. It is not cached: the universe is the
// cache, and a query over it costs less than a key.
func (s *ShortsServer) ListStockRegisters(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.ListStockRegistersRequest],
) (*connect.Response[shortsv1alpha1.ListStockRegistersResponse], error) {
	q, err := parseRegisterQuery(req.Msg)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	if s.ownershipStore == nil {
		return connect.NewResponse(&shortsv1alpha1.ListStockRegistersResponse{}), nil
	}
	u, err := s.ownershipUniverse.get(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("list stock registers: %w", err))
	}
	out, err := buildStockRegisters(u, q)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	return connect.NewResponse(out), nil
}
