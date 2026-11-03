package shorts

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The feed's reads, as the fake store serves them from its notices. The SQL is
// pinned against Postgres in postgres_ownership_pg_test.go; these reads follow
// the same rules (the filter, newest release first with the URL breaking ties,
// and the keyset) so the handlers can be tested without a database.

// noticeFeedRows is the notices the filter matches, newest release first.
func noticeFeedRows(rows []shortsstore.SubstantialNoticeRow, f shortsstore.NoticeFilter) []shortsstore.SubstantialNoticeRow {
	var out []shortsstore.SubstantialNoticeRow
	for _, n := range rows {
		if f.Since != "" && n.AnnouncedOn < f.Since {
			continue
		}
		if f.Event != "" && n.Event() != f.Event {
			continue
		}
		if f.Until != "" && n.AnnouncedOn > f.Until {
			continue
		}
		if f.Kind != "" && n.Kind != f.Kind {
			continue
		}
		if f.StockCode != "" && n.StockCode != f.StockCode {
			continue
		}
		if f.HolderKey != "" && n.HolderKey != f.HolderKey {
			continue
		}
		out = append(out, n)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].AnnouncedOn != out[j].AnnouncedOn {
			return out[i].AnnouncedOn > out[j].AnnouncedOn
		}
		return out[i].AnnouncementURL > out[j].AnnouncementURL
	})
	return out
}

func (f *fakeOwnershipStore) SubstantialNoticesPage(_ context.Context, filter shortsstore.NoticeFilter, cursorDate, cursorURL string, limit int) ([]shortsstore.SubstantialNoticeRow, error) {
	f.read("SubstantialNoticesPage")
	f.lastNoticeFilter = filter
	var out []shortsstore.SubstantialNoticeRow
	for _, n := range noticeFeedRows(f.notices, filter) {
		// Only rows before the cursor in the descending order: (announced_on,
		// announcement_url) < (cursor) in the keyset WHERE.
		if cursorDate != "" && (n.AnnouncedOn > cursorDate || (n.AnnouncedOn == cursorDate && n.AnnouncementURL >= cursorURL)) {
			continue
		}
		out = append(out, n)
		if len(out) == limit {
			break
		}
	}
	return out, nil
}

func (f *fakeOwnershipStore) CountSubstantialNotices(_ context.Context, filter shortsstore.NoticeFilter) (int, error) {
	f.read("CountSubstantialNotices")
	return len(noticeFeedRows(f.notices, filter)), nil
}

func (f *fakeOwnershipStore) NoticeActivity(_ context.Context, filter shortsstore.NoticeFilter) (shortsstore.NoticeActivityRows, error) {
	f.read("NoticeActivity")
	rows := noticeFeedRows(f.notices, filter)
	var out shortsstore.NoticeActivityRows
	weeks := map[string]*shortsstore.NoticeWeekRow{}
	var rises, falls []shortsstore.SubstantialNoticeRow
	for _, n := range rows {
		day, err := time.Parse(time.DateOnly, n.AnnouncedOn)
		if err != nil {
			return out, err
		}
		start := mondayOf(day).Format(time.DateOnly)
		if weeks[start] == nil {
			weeks[start] = &shortsstore.NoticeWeekRow{WeekStart: start}
		}
		addNoticeEvent(weeks[start], n.Event())
		switch n.Event() {
		case shortsstore.EventIncreased:
			rises = append(rises, n)
		case shortsstore.EventDecreased:
			falls = append(falls, n)
		}
	}
	for _, w := range weeks {
		out.Weeks = append(out.Weeks, *w)
	}
	sort.Slice(out.Weeks, func(i, j int) bool { return out.Weeks[i].WeekStart < out.Weeks[j].WeekStart })
	sort.SliceStable(rises, func(i, j int) bool { return moveSize(rises[i]) > moveSize(rises[j]) })
	sort.SliceStable(falls, func(i, j int) bool { return moveSize(falls[i]) < moveSize(falls[j]) })
	out.Rises, out.Falls = topFive(rises), topFive(falls)
	return out, nil
}

func addNoticeEvent(w *shortsstore.NoticeWeekRow, event string) {
	switch event {
	case shortsstore.EventBecame:
		w.Became++
	case shortsstore.EventIncreased:
		w.Increased++
	case shortsstore.EventDecreased:
		w.Decreased++
	case shortsstore.EventChanged:
		w.Changed++
	case shortsstore.EventCeased:
		w.Ceased++
	case shortsstore.EventNZ:
		w.NZ++
	}
}

// moveSize is a 604's rise or fall in percentage points.
func moveSize(n shortsstore.SubstantialNoticeRow) float64 {
	return *n.PresentPct - *n.PreviousPct
}

func topFive(rows []shortsstore.SubstantialNoticeRow) []shortsstore.SubstantialNoticeRow {
	if len(rows) > 5 {
		return rows[:5]
	}
	return rows
}

// feedNotices are six notices: three in the last month, two sharing a release
// date (so the announcement URL breaks the tie), a cessation, a September
// notice that only the whole register holds, and an NZ disclosure.
func feedNotices() []shortsstore.SubstantialNoticeRow {
	return []shortsstore.SubstantialNoticeRow{
		{StockCode: "PLS", HolderKey: "regal-partners", HolderName: "Regal Partners", InstitutionSlug: "regal-partners",
			Kind: "hedge_fund", Form: "603", PresentPct: new(6.0), AnnouncedOn: "2026-10-30", AnnouncementURL: "https://asx.example/a.pdf"},
		{StockCode: "BHP", HolderKey: "vanguard", HolderName: "Vanguard", InstitutionSlug: "vanguard",
			Kind: "index_manager", Form: "604", PresentPct: new(5.1), PreviousPct: new(5.0), AnnouncedOn: "2026-10-30", AnnouncementURL: "https://asx.example/b.pdf"},
		{StockCode: "MIN", HolderKey: "name:chris ellison", HolderName: "Chris Ellison",
			Kind: "unclassified", Form: "604", PresentPct: new(11.0), PreviousPct: new(12.0), AnnouncedOn: "2026-10-28", AnnouncementURL: "https://asx.example/c.pdf"},
		{StockCode: "PLS", HolderKey: "perpetual", HolderName: "Perpetual", InstitutionSlug: "perpetual",
			Kind: "active_manager", Form: "605", Ceased: true, PreviousPct: new(5.5), AnnouncedOn: "2026-10-20", AnnouncementURL: "https://asx.example/d.pdf"},
		{StockCode: "WC8", HolderKey: "asx:MIN", HolderName: "MIN Ltd",
			Kind: "corporate", Form: "nz", PresentPct: new(14.6), AnnouncedOn: "2026-10-09", AnnouncementURL: "https://asx.example/e.pdf"},
		{StockCode: "BHP", HolderKey: "citigroup", HolderName: "Citigroup", InstitutionSlug: "citigroup",
			Kind: "bank_broker", Form: "603", PresentPct: new(6.3), AnnouncedOn: "2026-09-01", AnnouncementURL: "https://asx.example/f.pdf"},
	}
}

// noticeTestServer serves the feed through the real handlers, from the fixture's
// universe and the given notices, on the fixed test clock.
func noticeTestServer(t *testing.T, notices []shortsstore.SubstantialNoticeRow) (*ShortsServer, *fakeOwnershipStore) {
	t.Helper()
	return noticeTestServerAt(t, notices, &fakeClock{t: ownershipTestNow})
}

// noticeTestServerAt is noticeTestServer on the given clock. A cache entry lives
// for the universe's remaining life measured on the wall clock, and the fixed test
// clock is already past, so on it an entry gets the one-second floor. A test that
// repeats a request and needs the repeat to hit starts its clock at time.Now().
func noticeTestServerAt(t *testing.T, notices []shortsstore.SubstantialNoticeRow, clock *fakeClock) (*ShortsServer, *fakeOwnershipStore) {
	t.Helper()
	store := newFakeOwnershipStore(ownershipFixture())
	store.notices = notices
	s := newOwnershipTestServer(store, clock)
	t.Cleanup(s.cache.(*MemoryCache).Close)
	return s, store
}

func feedRequest(window int32) *connect.Request[shortsv1alpha1.ListSubstantialNoticesRequest] {
	return connect.NewRequest(&shortsv1alpha1.ListSubstantialNoticesRequest{WindowDays: window})
}

func TestNoticeEventPrecedence(t *testing.T) {
	cases := []struct {
		name string
		row  shortsstore.SubstantialNoticeRow
		want string
	}{
		{"a 605 is ceased", shortsstore.SubstantialNoticeRow{Form: "605"}, shortsstore.EventCeased},
		{"the ceased flag beats a 604's move", shortsstore.SubstantialNoticeRow{Form: "604", Ceased: true,
			PresentPct: new(3.0), PreviousPct: new(5.0)}, shortsstore.EventCeased},
		{"a 603 became substantial", shortsstore.SubstantialNoticeRow{Form: "603", PresentPct: new(5.2)}, shortsstore.EventBecame},
		{"a 604 that rises is increased", shortsstore.SubstantialNoticeRow{Form: "604",
			PresentPct: new(6.2), PreviousPct: new(5.045)}, shortsstore.EventIncreased},
		{"a 604 that falls is decreased", shortsstore.SubstantialNoticeRow{Form: "604",
			PresentPct: new(4.9), PreviousPct: new(5.1)}, shortsstore.EventDecreased},
		{"a 604 with an equal figure is changed", shortsstore.SubstantialNoticeRow{Form: "604",
			PresentPct: new(5.0), PreviousPct: new(5.0)}, shortsstore.EventChanged},
		{"a 604 with no previous figure is changed", shortsstore.SubstantialNoticeRow{Form: "604",
			PresentPct: new(5.0)}, shortsstore.EventChanged},
		{"a 604 with no present figure is changed", shortsstore.SubstantialNoticeRow{Form: "604",
			PreviousPct: new(5.0)}, shortsstore.EventChanged},
		{"an NZ disclosure is nz", shortsstore.SubstantialNoticeRow{Form: "nz", PresentPct: new(7.0)}, shortsstore.EventNZ},
		{"an NZ cessation is ceased", shortsstore.SubstantialNoticeRow{Form: "nz", Ceased: true}, shortsstore.EventCeased},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			assert.Equal(t, c.want, c.row.Event())
		})
	}
}

// The clamps in clamps.json are the contract the web mirrors. This test reads
// the same file, from the repo root, and holds the handlers to it.
func TestClampsFixtureMatchesTheHandlers(t *testing.T) {
	type intCase struct {
		In  int32 `json:"in"`
		Out int32 `json:"out"`
	}
	type floatCase struct {
		In  float64 `json:"in"`
		Out float64 `json:"out"`
	}
	type stringCase struct {
		In  string `json:"in"`
		Out string `json:"out"`
	}
	type fixture struct {
		WindowDays          []intCase                `json:"windowDays"`
		WindowDaysNegative  []int32                  `json:"windowDaysNegative"`
		ActivityMaxWindow   int32                    `json:"activityMaxWindow"`
		Limit               []intCase                `json:"limit"`
		MinShortPct         []floatCase              `json:"minShortPct"`
		MinInterests        []intCase                `json:"minInterests"`
		Offset              struct{ Min, Max int32 } `json:"offset"`
		QueryMaxLength      int                      `json:"queryMaxLength"`
		DefaultRegisterSort string                   `json:"defaultRegisterSort"`
		RegisterSorts       []string                 `json:"registerSorts"`
		NoticeEvents        []string                 `json:"noticeEvents"`
		HolderKinds         []string                 `json:"holderKinds"`
		StockCode           struct {
			Valid   []string `json:"valid"`
			Invalid []string `json:"invalid"`
		} `json:"stockCode"`
		Cursor struct {
			Valid   string   `json:"valid"`
			Invalid []string `json:"invalid"`
		} `json:"cursor"`
		Normalised struct {
			StockCode       []stringCase `json:"stockCode"`
			Event           []stringCase `json:"event"`
			Kind            []stringCase `json:"kind"`
			InstitutionSlug []stringCase `json:"institutionSlug"`
			Sort            []stringCase `json:"sort"`
			Query           []struct {
				In       string `json:"in"`
				Code     string `json:"code"`
				Name     string `json:"name"`
				Rejected bool   `json:"rejected"`
			} `json:"query"`
		} `json:"normalised"`
	}
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "web", "src", "@", "lib", "ownership", "__fixtures__", "clamps.json"))
	require.NoError(t, err)
	var fx fixture
	require.NoError(t, json.Unmarshal(raw, &fx))

	assert.Equal(t, int32(noticeActivityMaxWindow), fx.ActivityMaxWindow)
	for _, c := range fx.WindowDays {
		got, err := servedNoticeWindow(c.In)
		require.NoError(t, err, "window %d", c.In)
		assert.Equal(t, c.Out, got, "window %d", c.In)
	}
	for _, days := range fx.WindowDaysNegative {
		_, err := servedNoticeWindow(days)
		assert.Error(t, err, "window %d must be rejected", days)
	}
	for _, c := range fx.Limit {
		assert.Equal(t, int(c.Out), pageLimit(c.In), "limit %d", c.In)
	}
	for _, c := range fx.MinShortPct {
		assert.InDelta(t, c.Out, snapShortPct(c.In), 1e-9, "min_short_pct %v", c.In)
	}
	for _, c := range fx.MinInterests {
		q, err := parseRegisterQuery(&shortsv1alpha1.ListStockRegistersRequest{MinInterests: c.In})
		require.NoError(t, err)
		assert.Equal(t, int(c.Out), q.minInterests, "min_interests %d", c.In)
	}
	_, err = parseRegisterQuery(&shortsv1alpha1.ListStockRegistersRequest{Offset: fx.Offset.Min})
	require.NoError(t, err)
	_, err = parseRegisterQuery(&shortsv1alpha1.ListStockRegistersRequest{Offset: fx.Offset.Max})
	require.NoError(t, err)
	_, err = parseRegisterQuery(&shortsv1alpha1.ListStockRegistersRequest{Offset: fx.Offset.Min - 1})
	assert.Error(t, err)
	_, err = parseRegisterQuery(&shortsv1alpha1.ListStockRegistersRequest{Offset: fx.Offset.Max + 1})
	assert.Error(t, err)

	atLimit := make([]byte, fx.QueryMaxLength)
	for i := range atLimit {
		atLimit[i] = 'a'
	}
	_, err = parseRegisterQuery(&shortsv1alpha1.ListStockRegistersRequest{Query: string(atLimit)})
	require.NoError(t, err)
	_, err = parseRegisterQuery(&shortsv1alpha1.ListStockRegistersRequest{Query: string(atLimit) + "a"})
	assert.Error(t, err)

	assert.Equal(t, defaultRegisterSort, fx.DefaultRegisterSort)
	assert.Equal(t, registerSorts, fx.RegisterSorts)
	assert.Equal(t, noticeEvents, fx.NoticeEvents)
	assert.Equal(t, holderKinds, fx.HolderKinds)

	for _, code := range fx.StockCode.Valid {
		assert.True(t, ownershipCodeRegex.MatchString(code), "stock_code %q", code)
	}
	for _, code := range fx.StockCode.Invalid {
		assert.False(t, ownershipCodeRegex.MatchString(code), "stock_code %q", code)
	}
	date, url, err := parseNoticeCursor(fx.Cursor.Valid)
	require.NoError(t, err)
	assert.Equal(t, noticeCursor(date, url), fx.Cursor.Valid)
	for _, cursor := range fx.Cursor.Invalid {
		_, _, err := parseNoticeCursor(cursor)
		assert.Error(t, err, "cursor %q", cursor)
	}

	// What a request's text becomes: trimmed and case-folded, as the web reads it.
	for _, c := range fx.Normalised.StockCode {
		q, err := parseNoticeFeedQuery(&shortsv1alpha1.ListSubstantialNoticesRequest{StockCode: c.In})
		require.NoError(t, err, "stock_code %q", c.In)
		assert.Equal(t, c.Out, q.stockCode, "stock_code %q", c.In)
	}
	for _, c := range fx.Normalised.Event {
		q, err := parseNoticeFeedQuery(&shortsv1alpha1.ListSubstantialNoticesRequest{Event: c.In})
		require.NoError(t, err, "event %q", c.In)
		assert.Equal(t, c.Out, q.event, "event %q", c.In)
	}
	for _, c := range fx.Normalised.Kind {
		q, err := parseNoticeFeedQuery(&shortsv1alpha1.ListSubstantialNoticesRequest{Kind: c.In})
		require.NoError(t, err, "kind %q", c.In)
		assert.Equal(t, c.Out, q.kind, "kind %q", c.In)
	}
	for _, c := range fx.Normalised.InstitutionSlug {
		q, err := parseNoticeFeedQuery(&shortsv1alpha1.ListSubstantialNoticesRequest{InstitutionSlug: c.In})
		require.NoError(t, err, "institution_slug %q", c.In)
		assert.Equal(t, c.Out, q.institutionSlug, "institution_slug %q", c.In)
	}
	for _, c := range fx.Normalised.Sort {
		q, err := parseRegisterQuery(&shortsv1alpha1.ListStockRegistersRequest{Sort: c.In})
		require.NoError(t, err, "sort %q", c.In)
		assert.Equal(t, c.Out, q.sort, "sort %q", c.In)
	}
	for _, c := range fx.Normalised.Query {
		q, err := parseRegisterQuery(&shortsv1alpha1.ListStockRegistersRequest{Query: c.In})
		if c.Rejected {
			assert.Error(t, err, "query %q is refused, not truncated", c.In)
			continue
		}
		require.NoError(t, err, "query %q", c.In)
		assert.Equal(t, c.Code, q.codePrefix, "query %q", c.In)
		assert.Equal(t, c.Name, q.nameSubstring, "query %q", c.In)
	}
}

func TestServedNoticeWindowAndSince(t *testing.T) {
	today := time.Date(2026, 11, 2, 9, 0, 0, 0, time.UTC)
	assert.Equal(t, "2026-10-26", noticeSince(7, today))
	assert.Equal(t, "2025-11-02", noticeSince(365, today))
	assert.Empty(t, noticeSince(0, today), "window 0 has no date clause: every notice the store holds")
	_, err := servedNoticeWindow(-1)
	require.Error(t, err)
}

func TestNoticeCursorIsItsKeyset(t *testing.T) {
	cursor := noticeCursor("2026-10-16", "https://www.asx.com.au/a|b.pdf")
	date, url, err := parseNoticeCursor(cursor)
	require.NoError(t, err)
	assert.Equal(t, "2026-10-16", date)
	assert.Equal(t, "https://www.asx.com.au/a|b.pdf", url, "the URL keeps a bar; the date never has one")
}

// Every clamp and every InvalidArgument of the feed is the handler's, not the
// store's.
func TestListSubstantialNoticesRejectsBadInput(t *testing.T) {
	s, _ := noticeTestServer(t, feedNotices())
	ctx := context.Background()
	cases := []struct {
		name string
		req  *shortsv1alpha1.ListSubstantialNoticesRequest
	}{
		{"a negative window", &shortsv1alpha1.ListSubstantialNoticesRequest{WindowDays: -1}},
		{"an event outside the vocabulary", &shortsv1alpha1.ListSubstantialNoticesRequest{Event: "sold"}},
		{"a kind outside the holder kinds", &shortsv1alpha1.ListSubstantialNoticesRequest{Kind: "trust"}},
		{"a stock code with a hyphen", &shortsv1alpha1.ListSubstantialNoticesRequest{StockCode: "BH-P"}},
		{"a stock code of seven characters", &shortsv1alpha1.ListSubstantialNoticesRequest{StockCode: "TOOLONG7"}},
		{"a since that is not a date", &shortsv1alpha1.ListSubstantialNoticesRequest{Since: "2026-02-30"}},
		{"an until before since", &shortsv1alpha1.ListSubstantialNoticesRequest{Since: "2026-10-20", Until: "2026-10-01"}},
		{"a since 367 days before today", &shortsv1alpha1.ListSubstantialNoticesRequest{Since: "2025-10-31"}},
		{"a since and until 367 days apart", &shortsv1alpha1.ListSubstantialNoticesRequest{Since: "2025-10-31", Until: "2026-11-02"}},
		{"a negative window beside dates", &shortsv1alpha1.ListSubstantialNoticesRequest{WindowDays: -1, Since: "2026-10-01"}},
		{"an institution outside the registry", &shortsv1alpha1.ListSubstantialNoticesRequest{InstitutionSlug: "nobody"}},
		{"a cursor without its bar", &shortsv1alpha1.ListSubstantialNoticesRequest{Cursor: "2026-10-16"}},
		{"a cursor with an empty URL", &shortsv1alpha1.ListSubstantialNoticesRequest{Cursor: "2026-10-16|"}},
		{"a cursor with an impossible date", &shortsv1alpha1.ListSubstantialNoticesRequest{Cursor: "2026-02-30|x"}},
		{"a cursor before the register", &shortsv1alpha1.ListSubstantialNoticesRequest{Cursor: "1999-12-31|x"}},
		{"a cursor dated year 0000", &shortsv1alpha1.ListSubstantialNoticesRequest{Cursor: "0000-01-01|x"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := s.ListSubstantialNotices(ctx, connect.NewRequest(c.req))
			require.Error(t, err)
			assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
		})
	}
}

func TestListSubstantialNoticesEchoesTheWindowAndEachNoticesEvent(t *testing.T) {
	s, _ := noticeTestServer(t, feedNotices())
	ctx := context.Background()

	resp, err := s.ListSubstantialNotices(ctx, feedRequest(8))
	require.NoError(t, err)
	assert.EqualValues(t, 30, resp.Msg.WindowDays, "8 days rounds up to the 30-day window")

	resp, err = s.ListSubstantialNotices(ctx, feedRequest(400))
	require.NoError(t, err)
	assert.EqualValues(t, 0, resp.Msg.WindowDays, "above the widest window is the whole register")

	resp, err = s.ListSubstantialNotices(ctx, feedRequest(0))
	require.NoError(t, err)
	assert.EqualValues(t, 0, resp.Msg.WindowDays)
	assert.EqualValues(t, 6, resp.Msg.Total)
	assert.Nil(t, resp.Msg.Activity, "the whole register carries no activity")

	var events []string
	for _, n := range resp.Msg.Notices {
		events = append(events, n.Event)
	}
	assert.Equal(t, []string{"increased", "became", "decreased", "ceased", "nz", "became"}, events,
		"newest first; the two notices of one release date run by URL")
}

// The keyset: each page starts strictly after the last pair of the page before,
// and the pages together are every notice once.
func TestNoticeFeedPagesByKeyset(t *testing.T) {
	s, _ := noticeTestServer(t, feedNotices())
	ctx := context.Background()
	var all []string
	cursor := ""
	pages := 0
	for {
		req := &shortsv1alpha1.ListSubstantialNoticesRequest{Limit: 2, Cursor: cursor}
		resp, err := s.ListSubstantialNotices(ctx, connect.NewRequest(req))
		require.NoError(t, err)
		pages++
		require.LessOrEqual(t, len(resp.Msg.Notices), 2)
		assert.EqualValues(t, 6, resp.Msg.Total, "the total does not narrow by cursor")
		for _, n := range resp.Msg.Notices {
			all = append(all, n.AnnouncementUrl)
		}
		if resp.Msg.NextCursor == "" {
			break
		}
		cursor = resp.Msg.NextCursor
		require.LessOrEqual(t, pages, 6, "paging must end")
	}
	assert.Equal(t, 3, pages)
	assert.Equal(t, []string{
		"https://asx.example/b.pdf", "https://asx.example/a.pdf",
		"https://asx.example/c.pdf", "https://asx.example/d.pdf",
		"https://asx.example/e.pdf", "https://asx.example/f.pdf",
	}, all, "every notice once, newest release first")
}

func TestListSubstantialNoticesCachesTheFirstPageOnly(t *testing.T) {
	// The clock starts at the wall clock, so the entry lives the universe's real
	// life and the repeat hits it whatever the second. Only read counts are
	// asserted, so the window's dates do not matter here.
	s, store := noticeTestServerAt(t, feedNotices(), &fakeClock{t: time.Now()})
	ctx := context.Background()
	req := &shortsv1alpha1.ListSubstantialNoticesRequest{WindowDays: 30, Limit: 2}
	_, err := s.ListSubstantialNotices(ctx, connect.NewRequest(req))
	require.NoError(t, err)
	_, err = s.ListSubstantialNotices(ctx, connect.NewRequest(req))
	require.NoError(t, err)
	assert.Equal(t, 1, store.readCount("SubstantialNoticesPage"), "the second first page is served from the cache")

	cursor := noticeCursor("2026-10-28", "https://asx.example/c.pdf")
	for range 2 {
		_, err = s.ListSubstantialNotices(ctx, connect.NewRequest(&shortsv1alpha1.ListSubstantialNoticesRequest{
			WindowDays: 30, Limit: 2, Cursor: cursor}))
		require.NoError(t, err)
	}
	assert.Equal(t, 3, store.readCount("SubstantialNoticesPage"), "a cursor page is read through every time")
}

func TestListSubstantialNoticesActivityFollowsTheWindow(t *testing.T) {
	s, _ := noticeTestServer(t, feedNotices())
	ctx := context.Background()

	for _, window := range []int32{0, 365} {
		resp, err := s.ListSubstantialNotices(ctx, connect.NewRequest(&shortsv1alpha1.ListSubstantialNoticesRequest{
			WindowDays: window, IncludeActivity: true}))
		require.NoError(t, err)
		assert.Nil(t, resp.Msg.Activity, "window %d is above a quarter, so no activity", window)
	}

	resp, err := s.ListSubstantialNotices(ctx, connect.NewRequest(&shortsv1alpha1.ListSubstantialNoticesRequest{
		WindowDays: 30, IncludeActivity: true}))
	require.NoError(t, err)
	require.NotNil(t, resp.Msg.Activity)
	act := resp.Msg.Activity
	assert.EqualValues(t, 5, resp.Msg.Total, "September's notice is outside the 30 days")
	assert.EqualValues(t, 1, act.Became)
	assert.EqualValues(t, 1, act.Increased)
	assert.EqualValues(t, 1, act.Decreased)
	assert.EqualValues(t, 0, act.Changed)
	assert.EqualValues(t, 1, act.Ceased)
	assert.EqualValues(t, 1, act.Nz)

	var starts []string
	for _, w := range act.Weeks {
		starts = append(starts, w.WeekStart)
	}
	assert.Equal(t, []string{"2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"}, starts,
		"every Monday from the window's first week, empty weeks included")
	assert.EqualValues(t, 1, act.Weeks[4].Became)
	assert.EqualValues(t, 1, act.Weeks[4].Increased)
	assert.EqualValues(t, 1, act.Weeks[4].Decreased)
	assert.EqualValues(t, 1, act.Weeks[3].Ceased)
	assert.EqualValues(t, 1, act.Weeks[1].Nz)
	require.Len(t, act.LargestRises, 1)
	assert.Equal(t, "BHP", act.LargestRises[0].StockCode)
	require.Len(t, act.LargestFalls, 1)
	assert.Equal(t, "MIN", act.LargestFalls[0].StockCode)
}

// noticeLetters names each notice by its letter in feedNotices, in the order
// given: every notice URL is https://asx.example/<letter>.pdf.
func noticeLetters(notices []*shortsv1alpha1.SubstantialNotice) []string {
	var out []string
	for _, n := range notices {
		name := strings.TrimPrefix(n.AnnouncementUrl, "https://asx.example/")
		out = append(out, strings.TrimSuffix(name, ".pdf"))
	}
	return out
}

// Each input of a first page reaches the store and is part of its key. Each page
// here differs from the others in some input, so a key that left one out would
// serve a page for a request it does not answer. Each page is read once; a repeat
// is served from its entry.
func TestFirstNoticePageKeysEveryInput(t *testing.T) {
	s, store := noticeTestServer(t, feedNotices())
	ctx := context.Background()
	cases := []struct {
		name        string
		req         *shortsv1alpha1.ListSubstantialNoticesRequest
		want        []string // the notices' letters, newest release first
		total       int32
		hasActivity bool
	}{
		{"the window", &shortsv1alpha1.ListSubstantialNoticesRequest{WindowDays: 30, Limit: 50},
			[]string{"b", "a", "c", "d", "e"}, 5, false},
		{"an event", &shortsv1alpha1.ListSubstantialNoticesRequest{WindowDays: 30, Limit: 50, Event: "ceased"},
			[]string{"d"}, 1, false},
		{"a smaller limit", &shortsv1alpha1.ListSubstantialNoticesRequest{WindowDays: 30, Limit: 2},
			[]string{"b", "a"}, 5, false},
		{"the activity", &shortsv1alpha1.ListSubstantialNoticesRequest{WindowDays: 30, Limit: 50, IncludeActivity: true},
			[]string{"b", "a", "c", "d", "e"}, 5, true},
		{"a kind in capitals", &shortsv1alpha1.ListSubstantialNoticesRequest{WindowDays: 30, Limit: 50, Kind: "Index_Manager"},
			[]string{"b"}, 1, false},
		{"a stock in lower case", &shortsv1alpha1.ListSubstantialNoticesRequest{WindowDays: 30, Limit: 50, StockCode: " pls "},
			[]string{"a", "d"}, 2, false},
		{"a registry holder", &shortsv1alpha1.ListSubstantialNoticesRequest{WindowDays: 30, Limit: 50, InstitutionSlug: "vanguard"},
			[]string{"b"}, 1, false},
		{"the whole register", &shortsv1alpha1.ListSubstantialNoticesRequest{WindowDays: 0, Limit: 50},
			[]string{"b", "a", "c", "d", "e", "f"}, 6, false},
	}
	for _, c := range cases {
		resp, err := s.ListSubstantialNotices(ctx, connect.NewRequest(c.req))
		require.NoError(t, err, c.name)
		assert.Equal(t, c.want, noticeLetters(resp.Msg.Notices), c.name)
		assert.Equal(t, c.total, resp.Msg.Total, c.name)
		assert.Equal(t, c.hasActivity, resp.Msg.Activity != nil, c.name)
	}
	assert.Equal(t, len(cases), store.readCount("SubstantialNoticesPage"), "one read per distinct page")

	// The repeat runs on a clock that starts at the wall clock, so its entry lives
	// the universe's real life (see noticeTestServerAt). The window cases name
	// dates measured back from the fixed clock, so the repeat asks for the whole
	// register, which has no date clause and answers the same on any day.
	live, liveStore := noticeTestServerAt(t, feedNotices(), &fakeClock{t: time.Now()})
	whole := &shortsv1alpha1.ListSubstantialNoticesRequest{WindowDays: 0, Limit: 50}
	for range 2 {
		resp, err := live.ListSubstantialNotices(ctx, connect.NewRequest(whole))
		require.NoError(t, err)
		assert.Equal(t, []string{"b", "a", "c", "d", "e", "f"}, noticeLetters(resp.Msg.Notices))
	}
	assert.Equal(t, 1, liveStore.readCount("SubstantialNoticesPage"), "a repeat is served from its entry")
}

// The activity follows the window's length: 90 days carries it, and 91 is served
// as the whole year, which carries none.
func TestNoticeFeedActivityStopsAtNinetyDays(t *testing.T) {
	s, _ := noticeTestServer(t, feedNotices())
	ctx := context.Background()
	within, err := s.ListSubstantialNotices(ctx, connect.NewRequest(&shortsv1alpha1.ListSubstantialNoticesRequest{
		WindowDays: 90, IncludeActivity: true}))
	require.NoError(t, err)
	assert.EqualValues(t, 90, within.Msg.WindowDays)
	assert.NotNil(t, within.Msg.Activity, "90 days carries the window's activity")

	beyond, err := s.ListSubstantialNotices(ctx, connect.NewRequest(&shortsv1alpha1.ListSubstantialNoticesRequest{
		WindowDays: 91, IncludeActivity: true}))
	require.NoError(t, err)
	assert.EqualValues(t, 365, beyond.Msg.WindowDays, "91 days is served as the year")
	assert.Nil(t, beyond.Msg.Activity)
}

// Activity belongs to the first page: a page after a cursor carries none and reads
// none.
func TestCursorPageCarriesNoActivity(t *testing.T) {
	s, store := noticeTestServer(t, feedNotices())
	ctx := context.Background()
	first, err := s.ListSubstantialNotices(ctx, connect.NewRequest(&shortsv1alpha1.ListSubstantialNoticesRequest{
		WindowDays: 30, Limit: 2, IncludeActivity: true}))
	require.NoError(t, err)
	require.NotNil(t, first.Msg.Activity)
	require.NotEmpty(t, first.Msg.NextCursor)

	next, err := s.ListSubstantialNotices(ctx, connect.NewRequest(&shortsv1alpha1.ListSubstantialNoticesRequest{
		WindowDays: 30, Limit: 2, IncludeActivity: true, Cursor: first.Msg.NextCursor}))
	require.NoError(t, err)
	assert.Nil(t, next.Msg.Activity)
	assert.Equal(t, []string{"c", "d"}, noticeLetters(next.Msg.Notices))
	assert.Equal(t, 1, store.readCount("NoticeActivity"), "only the first page reads the window's activity")
}

// The whole register has no date clause: an early notice (2 January 2024) is in
// its list and its total, as a stock's history count has it.
func TestWholeRegisterFeedHasNoDateClause(t *testing.T) {
	early := shortsstore.SubstantialNoticeRow{StockCode: "BHP", HolderKey: "vanguard", HolderName: "Vanguard",
		InstitutionSlug: "vanguard", Kind: "index_manager", Form: "603", PresentPct: new(5.2),
		AnnouncedOn: "2024-01-02", AnnouncementURL: "https://asx.example/early.pdf"}
	s, _ := noticeTestServer(t, append(feedNotices(), early))
	resp, err := s.ListSubstantialNotices(context.Background(), feedRequest(0))
	require.NoError(t, err)
	assert.EqualValues(t, 7, resp.Msg.Total)
	assert.Equal(t, []string{"b", "a", "c", "d", "e", "f", "early"}, noticeLetters(resp.Msg.Notices))
}

// A first page is read again for each universe. The entry read under the old
// generation is not served after the swap, and the as-of date is the universe that
// serves the page, never the one the entry was read beside.
func TestFirstNoticePageIsReadAgainForEachUniverse(t *testing.T) {
	clock := &fakeClock{t: ownershipTestNow}
	store := newFakeOwnershipStore(ownershipFixture())
	store.notices = feedNotices()[:1]
	s := newOwnershipTestServer(store, clock)
	t.Cleanup(s.cache.(*MemoryCache).Close)
	ctx := context.Background()
	req := feedRequest(30)

	first, err := s.ListSubstantialNotices(ctx, req)
	require.NoError(t, err)
	require.Len(t, first.Msg.Notices, 1)
	assert.Equal(t, "2026-10-16", first.Msg.AsOf)

	// A notice is released and the universe expires; the next one carries a later
	// as-of date.
	store.notices = append(store.notices, shortsstore.SubstantialNoticeRow{StockCode: "BHP", HolderKey: "vanguard",
		HolderName: "Vanguard", InstitutionSlug: "vanguard", Kind: "index_manager", Form: "604",
		PresentPct: new(5.2), PreviousPct: new(5.1), AnnouncedOn: "2026-10-30", AnnouncementURL: "https://asx.example/late.pdf"})
	next := ownershipFixture()
	next.stats.LatestAnnounced = "2026-10-30"
	store.d = next
	clock.set(ownershipTestNow.Add(ownershipTTL))

	second, err := s.ListSubstantialNotices(ctx, req)
	require.NoError(t, err)
	assert.Equal(t, []string{"late", "a"}, noticeLetters(second.Msg.Notices), "the entry read under the old generation is not served")
	assert.Equal(t, "2026-10-30", second.Msg.AsOf)
	assert.Equal(t, 2, store.readCount("SubstantialNoticesPage"))
}

// ttlRecordingCache records the lifetime each read asks its cache for.
type ttlRecordingCache struct {
	Cache
	ttls []time.Duration
}

func (c *ttlRecordingCache) GetOrSetWithTTL(key string, ttl time.Duration, computeFn func() (any, error)) (any, error) {
	c.ttls = append(c.ttls, ttl)
	return c.Cache.GetOrSetWithTTL(key, ttl, computeFn)
}

// A first page's entry lives no longer than the universe it was read beside, so
// it asks the cache for the universe's remaining life, never a fresh ownershipTTL.
// The cache measures lifetimes on the wall clock, so the fake clock starts nine
// minutes behind the wall clock: the universe has about a minute left by both.
func TestFirstNoticePageEntryLivesNoLongerThanItsUniverse(t *testing.T) {
	clock := &fakeClock{t: time.Now().Add(-(ownershipTTL - time.Minute))}
	store := newFakeOwnershipStore(ownershipFixture())
	store.notices = feedNotices()
	s := newOwnershipTestServer(store, clock)
	t.Cleanup(s.cache.(*MemoryCache).Close)
	recorder := &ttlRecordingCache{Cache: s.cache}
	s.cache = recorder

	_, err := s.ListSubstantialNotices(context.Background(), feedRequest(30))
	require.NoError(t, err)
	require.Len(t, recorder.ttls, 1)
	assert.Greater(t, recorder.ttls[0], 30*time.Second, "the universe's remaining life, not a fresh ownershipTTL")
	assert.LessOrEqual(t, recorder.ttls[0], time.Minute+time.Second, "no entry outlives the universe it was read beside")
}

// A window's weeks run across the year end: 30 days back from 6 January 2027 is
// the week of 7 December 2026.
func TestNoticeActivityFillsWeeksAcrossTheYearEnd(t *testing.T) {
	d := &ownershipData{}
	today := time.Date(2027, 1, 6, 9, 0, 0, 0, time.UTC)
	rows := shortsstore.NoticeActivityRows{Weeks: []shortsstore.NoticeWeekRow{{WeekStart: "2026-12-28", Changed: 2}}}
	out := d.buildNoticeActivity(rows, 30, today)
	var starts []string
	for _, w := range out.Weeks {
		starts = append(starts, w.WeekStart)
	}
	assert.Equal(t, []string{"2026-12-07", "2026-12-14", "2026-12-21", "2026-12-28", "2027-01-04"}, starts)
	assert.EqualValues(t, 2, out.Changed)
	assert.EqualValues(t, 2, out.Weeks[3].Changed)
}

// A notice released after today still gets its week, so the weeks cover every row.
func TestNoticeActivityCoversANoticeDatedAfterToday(t *testing.T) {
	d := &ownershipData{}
	today := time.Date(2027, 1, 6, 9, 0, 0, 0, time.UTC)
	rows := shortsstore.NoticeActivityRows{Weeks: []shortsstore.NoticeWeekRow{{WeekStart: "2027-01-11", NZ: 1}}}
	out := d.buildNoticeActivity(rows, 30, today)
	require.NotEmpty(t, out.Weeks)
	assert.Equal(t, "2027-01-11", out.Weeks[len(out.Weeks)-1].WeekStart)
	assert.EqualValues(t, 1, out.Nz)
}

// The register list's universe is the fixture's four stocks with a holder: WC8
// (14.6% disclosed), MIN (12%), PLS (11.5%) and BHP (11.4%). CBA has a share
// count and a short position but no holder, so it is not in the list.
func registerCodes(t *testing.T, u *ownershipUniverse, req *shortsv1alpha1.ListStockRegistersRequest) []string {
	t.Helper()
	q, err := parseRegisterQuery(req)
	require.NoError(t, err)
	out, err := buildStockRegisters(u, q)
	require.NoError(t, err)
	var codes []string
	for _, v := range out.Stocks {
		codes = append(codes, v.StockCode)
	}
	return codes
}

func TestListStockRegistersSortsAndFilters(t *testing.T) {
	u := ownershipFixtureUniverse()
	cases := []struct {
		name string
		req  *shortsv1alpha1.ListStockRegistersRequest
		want []string
	}{
		{"disclosed, descending by default", &shortsv1alpha1.ListStockRegistersRequest{},
			[]string{"WC8", "MIN", "PLS", "BHP"}},
		{"disclosed, ascending", &shortsv1alpha1.ListStockRegistersRequest{Ascending: true},
			[]string{"BHP", "PLS", "MIN", "WC8"}},
		{"short, descending: a stock with no short position sorts last", &shortsv1alpha1.ListStockRegistersRequest{Sort: "short"},
			[]string{"PLS", "MIN", "BHP", "WC8"}},
		{"short, ascending: still last", &shortsv1alpha1.ListStockRegistersRequest{Sort: "short", Ascending: true},
			[]string{"BHP", "MIN", "PLS", "WC8"}},
		{"index: unknowns last in both directions, ties by code", &shortsv1alpha1.ListStockRegistersRequest{Sort: "index"},
			[]string{"BHP", "MIN", "PLS", "WC8"}},
		{"index ascending keeps the unknowns last", &shortsv1alpha1.ListStockRegistersRequest{Sort: "index", Ascending: true},
			[]string{"BHP", "MIN", "PLS", "WC8"}},
		{"investors: a tie of zero is ordered by code", &shortsv1alpha1.ListStockRegistersRequest{Sort: "investors"},
			[]string{"PLS", "BHP", "MIN", "WC8"}},
		{"banks, ascending: the zeros by code, the bank's 6.3% last", &shortsv1alpha1.ListStockRegistersRequest{Sort: "banks", Ascending: true},
			[]string{"MIN", "PLS", "WC8", "BHP"}},
		{"hedge funds and active managers, ascending: PLS's 11.5% last", &shortsv1alpha1.ListStockRegistersRequest{Sort: "hedge_active", Ascending: true},
			[]string{"BHP", "MIN", "WC8", "PLS"}},
		{"super_value, descending: the stocks with no figure sort last", &shortsv1alpha1.ListStockRegistersRequest{Sort: "super_value"},
			[]string{"BHP", "PLS", "MIN", "WC8"}},
		{"super_value, ascending: still last", &shortsv1alpha1.ListStockRegistersRequest{Sort: "super_value", Ascending: true},
			[]string{"PLS", "BHP", "MIN", "WC8"}},
		{"super_options, ascending: a count of zero is a figure, so it sorts first", &shortsv1alpha1.ListStockRegistersRequest{Sort: "super_options", Ascending: true},
			[]string{"MIN", "WC8", "BHP", "PLS"}},
		{"interests, descending, ties by code", &shortsv1alpha1.ListStockRegistersRequest{Sort: "interests"},
			[]string{"BHP", "PLS", "MIN", "WC8"}},
		{"latest_notice, ascending: no notice date sorts last, not first", &shortsv1alpha1.ListStockRegistersRequest{Sort: "latest_notice", Ascending: true},
			[]string{"PLS", "BHP", "MIN", "WC8"}},
		{"code, descending: compared as text", &shortsv1alpha1.ListStockRegistersRequest{Sort: "code"},
			[]string{"WC8", "PLS", "MIN", "BHP"}},
		{"a kind must disclose 5% in the stock", &shortsv1alpha1.ListStockRegistersRequest{Kind: "hedge_fund"},
			[]string{"PLS"}},
		{"an index manager at 5.1% passes", &shortsv1alpha1.ListStockRegistersRequest{Kind: "index_manager"},
			[]string{"BHP"}},
		{"a minimum of two interests", &shortsv1alpha1.ListStockRegistersRequest{MinInterests: 2},
			[]string{"PLS", "BHP"}},
		{"a minimum short position of 3", &shortsv1alpha1.ListStockRegistersRequest{MinShortPct: 3},
			[]string{"MIN", "PLS"}},
		{"a minimum of 2.9 snaps down to 1", &shortsv1alpha1.ListStockRegistersRequest{MinShortPct: 2.9},
			[]string{"MIN", "PLS"}},
		{"a minimum under 1 filters nothing", &shortsv1alpha1.ListStockRegistersRequest{MinShortPct: 0.4},
			[]string{"WC8", "MIN", "PLS", "BHP"}},
		{"a name substring", &shortsv1alpha1.ListStockRegistersRequest{Query: "GROUP"},
			[]string{"PLS", "BHP"}},
		{"a code prefix", &shortsv1alpha1.ListStockRegistersRequest{Query: "min"},
			[]string{"MIN"}},
		{"an industry of the register", &shortsv1alpha1.ListStockRegistersRequest{Industry: " Materials "},
			[]string{"PLS", "BHP"}},
		{"a page", &shortsv1alpha1.ListStockRegistersRequest{Limit: 2, Offset: 1},
			[]string{"MIN", "PLS"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			assert.Equal(t, c.want, registerCodes(t, u, c.req))
		})
	}
}

// The cases above order by these figures, and a wrong kind can keep the same
// order. These pin the figures themselves.
func TestRegisterSortValuesSumTheirKinds(t *testing.T) {
	u := ownershipFixtureUniverse()
	assert.InDelta(t, 6.3, registerSortValue("banks", u.views["BHP"]).num, 1e-9, "the bank's figure, not the index fund's 5.1%")
	assert.InDelta(t, 0, registerSortValue("banks", u.views["PLS"]).num, 1e-9)
	assert.InDelta(t, 11.5, registerSortValue("hedge_active", u.views["PLS"]).num, 1e-9, "the hedge fund's 6% and the active manager's 5.5%")
	assert.InDelta(t, 0, registerSortValue("hedge_active", u.views["BHP"]).num, 1e-9, "BHP's index fund is neither")
}

// interests counts each interest once, while Holders counts holder rows. A holder
// off the map that discloses the same 6% on the same day as Regal Partners is one
// interest with it (a parent and its fund), so PLS has three holder rows and two
// interests.
func TestRegisterInterestsCountEachInterestOnce(t *testing.T) {
	d := ownershipFixture()
	d.holdings = append(d.holdings, shortsstore.SubstantialHoldingRow{StockCode: "PLS", HolderKey: "name:regal fund",
		Kind: "hedge_fund", PresentPct: 6, AnnouncedOn: "2026-10-02"})
	u := newOwnershipUniverse(d, ownershipFixtureCounts(), ownershipFixtureAttempts(), ownershipTestNow)

	pls := u.views["PLS"]
	require.EqualValues(t, 3, pls.Holders, "three holder rows")
	assert.Equal(t, 2, interestCount(pls), "two interests")
	assert.InDelta(t, 11.5, pls.DisclosedPct, 1e-9, "the shared interest is summed once")
	assert.InDelta(t, 2, registerSortValue("interests", pls).num, 1e-9)

	assert.Equal(t, []string{"BHP", "PLS", "MIN", "WC8"},
		registerCodes(t, u, &shortsv1alpha1.ListStockRegistersRequest{Sort: "interests"}), "PLS ties BHP at two interests")
	assert.Empty(t, registerCodes(t, u, &shortsv1alpha1.ListStockRegistersRequest{MinInterests: 3}),
		"no stock has three interests, though PLS has three holder rows")
}

func TestListStockRegistersCountsTheUniverseAndItsIndustries(t *testing.T) {
	u := ownershipFixtureUniverse()
	out, err := buildStockRegisters(u, registerQuery{sort: defaultRegisterSort, minInterests: 1, limit: pageDefaultLimit})
	require.NoError(t, err)
	assert.EqualValues(t, 4, out.Universe)
	assert.EqualValues(t, 4, out.Total)
	require.Len(t, out.Industries, 1, "CBA is in the register's share counts, not its holders")
	assert.Equal(t, "Materials", out.Industries[0].Industry)
	assert.EqualValues(t, 2, out.Industries[0].Stocks)
}

func TestListStockRegistersRejectsWhatItCannotFilter(t *testing.T) {
	cases := []struct {
		name string
		req  *shortsv1alpha1.ListStockRegistersRequest
	}{
		{"an unknown sort", &shortsv1alpha1.ListStockRegistersRequest{Sort: "sold"}},
		{"a kind outside the holder kinds", &shortsv1alpha1.ListStockRegistersRequest{Kind: "trust"}},
		{"a query over 24 characters", &shortsv1alpha1.ListStockRegistersRequest{Query: "abcdefghijklmnopqrstuvwxy"}},
		{"an offset past 5000", &shortsv1alpha1.ListStockRegistersRequest{Offset: 5001}},
		{"a negative offset", &shortsv1alpha1.ListStockRegistersRequest{Offset: -1}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := parseRegisterQuery(c.req)
			assert.Error(t, err)
		})
	}

	s, _ := noticeTestServer(t, feedNotices())
	_, err := s.ListStockRegisters(context.Background(), connect.NewRequest(&shortsv1alpha1.ListStockRegistersRequest{Industry: "Banks"}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), "CBA is not among the register's holders")
}

// The feed and the register list are served from the same universe as the rest
// of the ownership rpcs: one build answers them all.
func TestNoticeListsShareTheUniverseBuild(t *testing.T) {
	s, store := noticeTestServer(t, feedNotices())
	ctx := context.Background()
	_, err := s.GetOwnershipOverview(ctx, connect.NewRequest(&shortsv1alpha1.GetOwnershipOverviewRequest{}))
	require.NoError(t, err)
	_, err = s.GetStockOwnership(ctx, connect.NewRequest(&shortsv1alpha1.GetStockOwnershipRequest{StockCode: "BHP"}))
	require.NoError(t, err)
	_, err = s.ListStockRegisters(ctx, connect.NewRequest(&shortsv1alpha1.ListStockRegistersRequest{}))
	require.NoError(t, err)
	_, err = s.ListSubstantialNotices(ctx, feedRequest(30))
	require.NoError(t, err)
	assert.Equal(t, 1, store.readCount("OwnershipInstitutions"), "one universe build serves every ownership rpc")
}

// A notice's event rides on every SubstantialNotice the register returns, the
// stock's history included, not only on the feed.
func TestStockHistoryCarriesTheEvent(t *testing.T) {
	s, _ := noticeTestServer(t, feedNotices())
	resp, err := s.GetStockOwnership(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetStockOwnershipRequest{StockCode: "BHP"}))
	require.NoError(t, err)
	var events []string
	for _, n := range resp.Msg.History {
		events = append(events, n.Event)
	}
	assert.ElementsMatch(t, []string{"increased", "became"}, events)
}

func TestNoticeListsAnswerEmptyWithoutAStore(t *testing.T) {
	s := &ShortsServer{}
	ctx := context.Background()
	resp, err := s.ListSubstantialNotices(ctx, feedRequest(30))
	require.NoError(t, err)
	assert.EqualValues(t, 30, resp.Msg.WindowDays)
	assert.Empty(t, resp.Msg.Notices)

	regs, err := s.ListStockRegisters(ctx, connect.NewRequest(&shortsv1alpha1.ListStockRegistersRequest{}))
	require.NoError(t, err)
	assert.Empty(t, regs.Msg.Stocks)

	_, err = s.ListSubstantialNotices(ctx, feedRequest(-1))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), "a malformed request is a client error with or without a store")
}

// snapShortPct and pageLimit are the two clamps the fixture pins; these are the
// boundary values, written out for the reader.
func TestClampBoundaries(t *testing.T) {
	assert.Equal(t, 0.0, snapShortPct(math.NaN()), "NaN filters nothing")
	assert.Equal(t, 10.0, snapShortPct(math.Inf(1)))
	assert.Equal(t, pageDefaultLimit, pageLimit(0))
	assert.Equal(t, pageMaxLimit, pageLimit(1000))
}

func TestListSubstantialNoticesNarrowsByIndustryAndDates(t *testing.T) {
	// The industry and the dates reach the store as the filter. A narrowed query
	// is read through, since the first-page cache does not key on them, and it
	// carries no activity: its weeks would not cover the rows the dates keep.
	s, store := noticeTestServer(t, feedNotices())
	ctx := context.Background()
	req := &shortsv1alpha1.ListSubstantialNoticesRequest{
		Industry: " Materials ", Since: "2026-10-01", Until: "2026-10-20", IncludeActivity: true,
	}
	resp, err := s.ListSubstantialNotices(ctx, connect.NewRequest(req))
	require.NoError(t, err)
	assert.Equal(t, shortsstore.NoticeFilter{Since: "2026-10-01", Until: "2026-10-20", Industry: "Materials"},
		store.lastNoticeFilter)
	assert.Nil(t, resp.Msg.Activity, "a query with its own dates carries no activity")
	_, err = s.ListSubstantialNotices(ctx, connect.NewRequest(req))
	require.NoError(t, err)
	assert.Equal(t, 2, store.readCount("SubstantialNoticesPage"), "a narrowed query is read through every time")

	// The dates are the window: a window_days beside them is ignored, and the
	// response echoes 0. This is a heatmap cell's week, which a 30-day window
	// would have cut to nothing.
	resp, err = s.ListSubstantialNotices(ctx, connect.NewRequest(&shortsv1alpha1.ListSubstantialNoticesRequest{
		WindowDays: 30, Since: "2026-03-02", Until: "2026-03-08"}))
	require.NoError(t, err)
	assert.Equal(t, shortsstore.NoticeFilter{Since: "2026-03-02", Until: "2026-03-08"}, store.lastNoticeFilter)
	assert.Equal(t, int32(0), resp.Msg.WindowDays)
}

func TestNamedDatesReplaceTheWindowAndSpan(t *testing.T) {
	s, store := noticeTestServer(t, feedNotices())
	ctx := context.Background()
	today := ownershipTestNow.UTC()
	read := func(req *shortsv1alpha1.ListSubstantialNoticesRequest) shortsstore.NoticeFilter {
		t.Helper()
		_, err := s.ListSubstantialNotices(ctx, connect.NewRequest(req))
		require.NoError(t, err)
		return store.lastNoticeFilter
	}

	// A since with no until runs to today, and no window applies beside it.
	assert.Equal(t, shortsstore.NoticeFilter{Since: "2026-09-01"},
		read(&shortsv1alpha1.ListSubstantialNoticesRequest{WindowDays: 7, Since: "2026-09-01"}))

	// An until with no since starts 365 days before it, the span a desk window
	// allows at most (366 days inclusive).
	assert.Equal(t, shortsstore.NoticeFilter{Since: "2025-10-20", Until: "2026-10-20"},
		read(&shortsv1alpha1.ListSubstantialNoticesRequest{Until: "2026-10-20"}))

	// A span of exactly the cap (366 days apart) is served; one day more is not.
	edge := today.AddDate(0, 0, -deskMaxSpanDays).Format(time.DateOnly)
	assert.Equal(t, edge, read(&shortsv1alpha1.ListSubstantialNoticesRequest{Since: edge}).Since)
	_, err := s.ListSubstantialNotices(ctx, connect.NewRequest(&shortsv1alpha1.ListSubstantialNoticesRequest{
		Since: today.AddDate(0, 0, -(deskMaxSpanDays + 1)).Format(time.DateOnly)}))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), "a span over the cap is refused")

	// Dated queries are read through and carry no activity.
	resp, err := s.ListSubstantialNotices(ctx, connect.NewRequest(&shortsv1alpha1.ListSubstantialNoticesRequest{
		WindowDays: 30, Since: "2026-10-01", IncludeActivity: true}))
	require.NoError(t, err)
	assert.Nil(t, resp.Msg.Activity)
}
