package shorts

import (
	"testing"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"github.com/jackc/pgx/v5"
	"go.uber.org/mock/gomock"
)

func TestListStockPoliticiansCountsPeopleNotRows(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	server := newTestServer(t, store)

	// One member declaring the same company twice (two statements) plus a second
	// member. The count must be 2 PEOPLE, not 3 rows.
	people := []*shortsstore.PoliticianRow{
		{Slug: "jane-doe", DisplayName: "Jane Doe", PartyAb: "ALP"},
		{Slug: "jane-doe", DisplayName: "Jane Doe", PartyAb: "ALP"},
		{Slug: "john-roe", DisplayName: "John Roe", PartyAb: "LP"},
	}
	interests := []*shortsstore.DeclaredInterestRow{
		{ItemNo: 1, Holder: "self", DeclaredText: "CBA", StockCode: "CBA", CurrentlyDeclared: true},
		{ItemNo: 1, Holder: "spouse_partner", DeclaredText: "CBA", StockCode: "CBA"},
		{ItemNo: 1, Holder: "self", DeclaredText: "CBA", StockCode: "CBA", CurrentlyDeclared: true},
	}
	parties := []*shortsstore.PartyCountRow{{PartyAb: "ALP", Party: "Labor", PoliticianCount: 1}}

	store.EXPECT().ListStockPoliticians("CBA", false).
		Return("Commonwealth Bank", people, interests, parties, nil).Times(1)

	resp, err := server.ListStockPoliticians(t.Context(),
		connect.NewRequest(&shortsv1alpha1.ListStockPoliticiansRequest{StockCode: "cba"}))
	if err != nil {
		t.Fatalf("ListStockPoliticians: %v", err)
	}
	if got := resp.Msg.PoliticianCount; got != 2 {
		t.Errorf("politicianCount = %d, want 2 distinct people", got)
	}
	if len(resp.Msg.Interests) != 3 {
		t.Errorf("interests = %d, want all 3 rows retained", len(resp.Msg.Interests))
	}
	// The licence must ride along, or a consumer can render the data unattributed.
	if resp.Msg.SourceLicence == "" {
		t.Error("response carries no source licence")
	}

	// A second call is served from cache — the store must not be hit again.
	if _, err := server.ListStockPoliticians(t.Context(),
		connect.NewRequest(&shortsv1alpha1.ListStockPoliticiansRequest{StockCode: "CBA"})); err != nil {
		t.Fatalf("second call: %v", err)
	}
}

// The holder is what tells a reader whose interest this is. Losing it in the
// mapping would attribute a spouse's holding to the member.
func TestHolderMappingRoundTrips(t *testing.T) {
	cases := map[string]shortsv1alpha1.RegisterHolder{
		"self":               shortsv1alpha1.RegisterHolder_REGISTER_HOLDER_SELF,
		"spouse_partner":     shortsv1alpha1.RegisterHolder_REGISTER_HOLDER_SPOUSE_PARTNER,
		"dependent_children": shortsv1alpha1.RegisterHolder_REGISTER_HOLDER_DEPENDENT_CHILDREN,
		"unspecified":        shortsv1alpha1.RegisterHolder_REGISTER_HOLDER_UNSPECIFIED,
		"":                   shortsv1alpha1.RegisterHolder_REGISTER_HOLDER_UNSPECIFIED,
	}
	for in, want := range cases {
		if got := registerHolderProto(in); got != want {
			t.Errorf("registerHolderProto(%q) = %v, want %v", in, got, want)
		}
	}
}

// An unknown declaration start must stay unknown on the wire. The zero time
// would serialise as 1 January year 1, which a consumer renders as a real date.
func TestUnknownDeclaredFromIsNilNotZeroTime(t *testing.T) {
	row := &shortsstore.DeclaredInterestRow{
		ItemNo: 1, Holder: "self", DeclaredText: "BHP",
		DeclaredFromKnown: false, // no date on the base statement
	}
	got := declaredInterestProto(row)
	if got.DeclaredFrom != nil {
		t.Errorf("declaredFrom = %v, want nil so the UI shows an unknown start", got.DeclaredFrom.AsTime())
	}
	if got.DeclaredFromKnown {
		t.Error("declaredFromKnown must stay false")
	}
	if got.DeclaredTo != nil {
		t.Errorf("declaredTo = %v, want nil while still declared", got.DeclaredTo.AsTime())
	}

	// A real date still survives.
	when := time.Date(2025, 8, 18, 0, 0, 0, 0, time.UTC)
	row.DeclaredFrom, row.DeclaredFromKnown = when, true
	if got := declaredInterestProto(row); got.DeclaredFrom == nil || !got.DeclaredFrom.AsTime().Equal(when) {
		t.Errorf("a known date was lost: %v", got.DeclaredFrom)
	}
}

// The caveat has to be served WITH the data. A member's name beside a rising
// short line is the juxtaposition editorial rule 2 governs, and a consumer must
// not have to remember the disclaimer.
func TestShortInterestOverlapAlwaysCarriesItsDisclosure(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	server := newTestServer(t, store)

	store.EXPECT().ListShortInterestOverlap(2.0, int32(50)).
		Return([]*shortsstore.PoliticianStockRollupRow{
			{StockCode: "TWE", CompanyName: "Treasury Wine", ShortPercent: 10.92, PoliticianCount: 2},
		}, nil).Times(1)

	resp, err := server.ListShortInterestOverlap(t.Context(),
		connect.NewRequest(&shortsv1alpha1.ListShortInterestOverlapRequest{}))
	if err != nil {
		t.Fatalf("ListShortInterestOverlap: %v", err)
	}
	if resp.Msg.DisclosureNote == "" {
		t.Fatal("no disclosure note served with short-interest data")
	}
	for _, phrase := range []string{"company", "never quantity or value"} {
		if !containsString(resp.Msg.DisclosureNote, phrase) {
			t.Errorf("disclosure is missing %q: %s", phrase, resp.Msg.DisclosureNote)
		}
	}
}

// The kill switch must degrade the surface, not break the page: an empty
// response, never an error.
func TestKillSwitchReturnsEmptyNotError(t *testing.T) {
	t.Setenv("POLITICIAN_INTERESTS_ENABLED", "false")
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	server := newTestServer(t, store)

	// No store call may happen at all.
	resp, err := server.ListStockPoliticians(t.Context(),
		connect.NewRequest(&shortsv1alpha1.ListStockPoliticiansRequest{StockCode: "CBA"}))
	if err != nil {
		t.Fatalf("kill switch produced an error: %v", err)
	}
	if len(resp.Msg.Interests) != 0 || resp.Msg.PoliticianCount != 0 {
		t.Error("kill switch returned data")
	}

	ov, err := server.GetParliamentOverview(t.Context(),
		connect.NewRequest(&shortsv1alpha1.GetParliamentOverviewRequest{}))
	if err != nil {
		t.Fatalf("kill switch produced an error: %v", err)
	}
	if ov.Msg.PoliticianCount != 0 {
		t.Error("kill switch returned counts")
	}
}

func TestKillSwitchDefaultsOn(t *testing.T) {
	t.Setenv("POLITICIAN_INTERESTS_ENABLED", "")
	if !registerEnabled() {
		t.Error("the surface must be enabled by default; the env var is a kill switch, not an opt-in")
	}
	for _, off := range []string{"false", "0", "off", "no", "FALSE"} {
		t.Setenv("POLITICIAN_INTERESTS_ENABLED", off)
		if registerEnabled() {
			t.Errorf("%q did not disable the surface", off)
		}
	}
	t.Setenv("POLITICIAN_INTERESTS_ENABLED", "nonsense")
	if !registerEnabled() {
		t.Error("an unparseable value must leave the surface enabled")
	}
}

func TestRequiredArgumentsAreValidated(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	server := newTestServer(t, store)

	if _, err := server.GetPolitician(t.Context(),
		connect.NewRequest(&shortsv1alpha1.GetPoliticianRequest{Slug: "  "})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("blank slug: code = %v, want InvalidArgument", connect.CodeOf(err))
	}
	if _, err := server.ListStockPoliticians(t.Context(),
		connect.NewRequest(&shortsv1alpha1.ListStockPoliticiansRequest{})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("blank stock code: code = %v, want InvalidArgument", connect.CodeOf(err))
	}
	if _, err := server.ListSuburbPoliticians(t.Context(),
		connect.NewRequest(&shortsv1alpha1.ListSuburbPoliticiansRequest{})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("blank sal code: code = %v, want InvalidArgument", connect.CodeOf(err))
	}
	// An arbitrary string must not reach the query.
	if _, err := server.ListStatePoliticianHoldings(t.Context(),
		connect.NewRequest(&shortsv1alpha1.ListStatePoliticianHoldingsRequest{StateCode: "Atlantis"})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("bogus state: code = %v, want InvalidArgument", connect.CodeOf(err))
	}
}

func TestMissingPoliticianIsNotFoundNotInternal(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	server := newTestServer(t, store)

	store.EXPECT().GetPolitician("nobody").Return(nil, nil, nil, pgx.ErrNoRows).Times(1)

	_, err := server.GetPolitician(t.Context(),
		connect.NewRequest(&shortsv1alpha1.GetPoliticianRequest{Slug: "nobody"}))
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("code = %v, want NotFound", connect.CodeOf(err))
	}
}

// Limits are normalised BEFORE the cache key is built, so a key can never
// describe a different query than the one whose result it holds.
func TestClampLimit(t *testing.T) {
	cases := []struct{ req, def, max, want int32 }{
		{0, 50, 200, 50},
		{-5, 50, 200, 50},
		{10, 50, 200, 10},
		{5000, 50, 200, 200},
		{200, 50, 200, 200},
	}
	for _, c := range cases {
		if got := clampLimit(c.req, c.def, c.max); got != c.want {
			t.Errorf("clampLimit(%d, %d, %d) = %d, want %d", c.req, c.def, c.max, got, c.want)
		}
	}
}

// A cache key built from a raw time.Time would embed a monotonic clock reading
// and be unique on every call, silently disabling the cache.
func TestRegisterChangesCacheKeyIsStableForTheSameDay(t *testing.T) {
	cache := NewMemoryCache(time.Minute)
	a := time.Date(2026, 7, 1, 9, 30, 0, 0, time.UTC)
	b := time.Date(2026, 7, 1, 21, 45, 12, 500, time.UTC)
	if cache.ListRegisterChangesKey(a, "added", "CBA", 100, 0) != cache.ListRegisterChangesKey(b, "added", "CBA", 100, 0) {
		t.Error("keys differ for the same day; the cache would never hit")
	}
	other := time.Date(2026, 7, 2, 9, 30, 0, 0, time.UTC)
	if cache.ListRegisterChangesKey(a, "added", "CBA", 100, 0) == cache.ListRegisterChangesKey(other, "added", "CBA", 100, 0) {
		t.Error("different days must not share a key")
	}
}

func containsString(haystack, needle string) bool {
	return len(needle) == 0 || indexOfString(haystack, needle) >= 0
}

func indexOfString(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
