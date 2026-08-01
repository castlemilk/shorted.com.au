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
	"google.golang.org/protobuf/reflect/protoreflect"
)

// The kill switch must return an EMPTY response, never an error: a takedown or
// a data dispute takes the surface down without breaking the page around it.
func TestDiscoveryRPCsKillSwitchReturnEmptyNotError(t *testing.T) {
	t.Setenv("POLITICIAN_INTERESTS_ENABLED", "false")
	ctrl := gomock.NewController(t)
	// No EXPECT at all: a store call under the kill switch is a failure.
	store := mocks.NewMockShortsStore(ctrl)
	server := newTestServer(t, store)

	activity, err := server.GetRegisterActivity(t.Context(),
		connect.NewRequest(&shortsv1alpha1.GetRegisterActivityRequest{WindowDays: 90}))
	if err != nil || len(activity.Msg.GetWeeks()) != 0 || activity.Msg.GetSourceLicence() != "" ||
		activity.Msg.GetAsAt() != nil || activity.Msg.GetUndatedCurrentCount() != 0 {
		t.Fatalf("GetRegisterActivity kill switch = (%v, %v), want an empty response", activity, err)
	}

	holdings, err := server.ListDistinctiveHoldings(t.Context(),
		connect.NewRequest(&shortsv1alpha1.ListDistinctiveHoldingsRequest{Slug: "alice-example"}))
	if err != nil || len(holdings.Msg.GetHoldings()) != 0 || holdings.Msg.GetCanonicalSlug() != "" ||
		holdings.Msg.GetDisclosureNote() != "" {
		t.Fatalf("ListDistinctiveHoldings kill switch = (%v, %v), want an empty response", holdings, err)
	}
}

// The window is snapped BEFORE the cache key is built, so a key can never
// describe a window other than the one whose result it holds. Requests that
// snap to the same width must therefore share one store call.
func TestRegisterActivityClampsWindowBeforeStoreAndCache(t *testing.T) {
	cases := []struct{ requested, want int32 }{
		{0, 90}, {-30, 90}, {1, 30}, {30, 30}, {31, 90}, {90, 90},
		{120, 180}, {180, 180}, {200, 365}, {365, 365}, {99999, 365},
	}
	for _, c := range cases {
		if got := clampRegisterActivityWindow(c.requested); got != c.want {
			t.Errorf("clampRegisterActivityWindow(%d) = %d, want %d", c.requested, got, c.want)
		}
	}

	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	server := newTestServer(t, store)

	// 45 and 90 both snap to 90: exactly ONE store call may happen.
	store.EXPECT().GetRegisterActivity(int32(90)).Return(&shortsstore.RegisterActivityRow{
		WindowDays: 90,
		Weeks: []*shortsstore.WeeklyEventCountRow{
			{WeekStart: "2026-07-13", AddedCount: 17, RemovedCount: 0},
		},
		ActiveMembers:          []*shortsstore.ActiveMemberRow{{Slug: "alice-example", DisplayName: "Alice Example", EventCount: 9}},
		NewlyDeclaredCompanies: []*shortsstore.NewlyDeclaredCompanyRow{{StockCode: "ASX", FirstDeclaredOn: "2026-07-08", DeclarerCount: 2}},
		DeclarerCountChanges:   []*shortsstore.DeclarerCountChangeRow{{StockCode: "ASX", DeclarersNow: 1, DeclarersAtWindowStart: 0}},
		UndatedCurrentCount:    13615,
		AsAt:                   time.Date(2026, 7, 21, 0, 0, 0, 0, time.UTC),
	}, nil).Times(1)

	first, err := server.GetRegisterActivity(t.Context(),
		connect.NewRequest(&shortsv1alpha1.GetRegisterActivityRequest{WindowDays: 45}))
	if err != nil {
		t.Fatalf("GetRegisterActivity(45): %v", err)
	}
	if first.Msg.GetWindowDays() != 90 {
		t.Errorf("windowDays = %d, want the clamped 90 reported back", first.Msg.GetWindowDays())
	}
	second, err := server.GetRegisterActivity(t.Context(),
		connect.NewRequest(&shortsv1alpha1.GetRegisterActivityRequest{WindowDays: 90}))
	if err != nil || second.Msg.GetWindowDays() != first.Msg.GetWindowDays() {
		t.Fatalf("clamped requests did not share a cache entry: (%v, %v)", second, err)
	}

	// The dated-only discipline's exclusions are PUBLISHED, not silently absent.
	if first.Msg.GetUndatedCurrentCount() != 13615 {
		t.Errorf("undatedCurrentCount = %d, want the excluded rows reported", first.Msg.GetUndatedCurrentCount())
	}
	if first.Msg.GetSourceLicence() == "" || first.Msg.GetAsAt() == nil {
		t.Error("activity response must carry the licence and the register's as-at")
	}
	if first.Msg.GetAsAt().AsTime() != time.Date(2026, 7, 21, 0, 0, 0, 0, time.UTC) {
		t.Errorf("asAt = %v, want the newest lodgement, not our refresh clock", first.Msg.GetAsAt().AsTime())
	}
}

// An empty window must still say which register it is empty OF, using the
// register's own clock (the newest lodgement), never our snapshot clock.
func TestRegisterActivityEmptyWindowStillCarriesTheRegistersClock(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	server := newTestServer(t, store)

	lodged := time.Date(2026, 7, 21, 0, 0, 0, 0, time.UTC)
	store.EXPECT().GetRegisterActivity(int32(30)).
		Return(&shortsstore.RegisterActivityRow{WindowDays: 30}, nil).Times(1)
	store.EXPECT().GetRegisterOverview().Return(&shortsstore.RegisterOverviewRow{
		AsAt: lodged, RefreshedAt: time.Date(2026, 7, 31, 0, 0, 0, 0, time.UTC),
	}, nil).Times(1)

	resp, err := server.GetRegisterActivity(t.Context(),
		connect.NewRequest(&shortsv1alpha1.GetRegisterActivityRequest{WindowDays: 30}))
	if err != nil {
		t.Fatalf("GetRegisterActivity: %v", err)
	}
	if resp.Msg.GetAsAt() == nil || !resp.Msg.GetAsAt().AsTime().Equal(lodged) {
		t.Errorf("asAt = %v, want the newest lodgement %v", resp.Msg.GetAsAt(), lodged)
	}
}

// The short-interest caveat is served WITH the data. A member's name beside a
// short figure is the juxtaposition editorial rule 2 governs, and a consumer
// must not have to remember the disclaimer.
func TestDistinctiveHoldingsDiscloseShortInterestOnlyWhenPresent(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	server := newTestServer(t, store)

	store.EXPECT().ListDistinctiveHoldings("ged-kearney").Return(&shortsstore.DistinctiveHoldingsRow{
		CanonicalSlug: "ged-kearney",
		Holdings: []*shortsstore.DistinctiveHoldingRow{
			{StockCode: "BAP", Holder: "unspecified", CurrentlyDeclared: true, CorpusDeclarerCount: 1, ShortPercent: 9.82},
			{StockCode: "CZR", Holder: "spouse_partner", CurrentlyDeclared: true, CorpusDeclarerCount: 1},
		},
		MoreCount: 5,
		AsAt:      time.Date(2026, 7, 21, 0, 0, 0, 0, time.UTC),
	}, nil).Times(1)

	// Trimmed + lower-cased is the canonical form, and the normalised slug is
	// what reaches both the store and the cache key.
	resp, err := server.ListDistinctiveHoldings(t.Context(),
		connect.NewRequest(&shortsv1alpha1.ListDistinctiveHoldingsRequest{Slug: " GED-KEARNEY "}))
	if err != nil {
		t.Fatalf("ListDistinctiveHoldings: %v", err)
	}
	if resp.Msg.GetDisclosureNote() != shortInterestDisclosure {
		t.Errorf("disclosureNote = %q, want the mandatory short-interest caveat", resp.Msg.GetDisclosureNote())
	}
	if resp.Msg.GetCanonicalSlug() != "ged-kearney" || resp.Msg.GetMoreCount() != 5 {
		t.Errorf("canonicalSlug/moreCount lost: %v", resp.Msg)
	}
	if resp.Msg.GetHoldings()[1].GetHolder() != shortsv1alpha1.RegisterHolder_REGISTER_HOLDER_SPOUSE_PARTNER {
		t.Errorf("holder mapping lost: %v", resp.Msg.GetHoldings()[1])
	}
	if resp.Msg.GetSourceLicence() == "" || resp.Msg.GetAsAt() == nil {
		t.Error("holdings response must carry the licence and the register's as-at")
	}
	// A second call with the already-normalised slug is served from cache.
	if _, err := server.ListDistinctiveHoldings(t.Context(),
		connect.NewRequest(&shortsv1alpha1.ListDistinctiveHoldingsRequest{Slug: "ged-kearney"})); err != nil {
		t.Fatalf("cached call: %v", err)
	}

	// No short figure anywhere means NO caveat: it must never appear without
	// the thing it is caveating.
	quiet := distinctiveHoldingsProto(&shortsstore.DistinctiveHoldingsRow{
		CanonicalSlug: "bob-example",
		Holdings:      []*shortsstore.DistinctiveHoldingRow{{StockCode: "CZR", CorpusDeclarerCount: 1}},
	})
	if quiet.GetDisclosureNote() != "" {
		t.Errorf("disclosureNote = %q, want empty when no row carries a short figure", quiet.GetDisclosureNote())
	}
}

func TestDistinctiveHoldingsValidatesSlugAndMapsMissingToNotFound(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	server := newTestServer(t, store)

	if _, err := server.ListDistinctiveHoldings(t.Context(),
		connect.NewRequest(&shortsv1alpha1.ListDistinctiveHoldingsRequest{Slug: "  "})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("blank slug: code = %v, want InvalidArgument", connect.CodeOf(err))
	}

	store.EXPECT().ListDistinctiveHoldings("nobody").Return(nil, pgx.ErrNoRows).Times(1)
	if _, err := server.ListDistinctiveHoldings(t.Context(),
		connect.NewRequest(&shortsv1alpha1.ListDistinctiveHoldingsRequest{Slug: "nobody"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("missing member: code = %v, want NotFound", connect.CodeOf(err))
	}
}

// The discovery layer must remain countable-only. No magnitude vocabulary and
// no scoring/labelling vocabulary may appear as a field on any of its messages
// — the editorial rules are enforced here, not just in review.
func TestDiscoveryMessagesCarryNoMagnitudeOrLabelFields(t *testing.T) {
	banned := []string{
		// Rule 5: what is held, never how much.
		"amount", "value", "worth", "price", "quantity", "size", "balance",
		// The banned risk/monitor class, and any derived ranking.
		"score", "risk", "rank", "ranking", "flag", "status", "severity",
		"unusual", "anomaly", "alert", "watch",
	}
	messages := []protoreflect.ProtoMessage{
		&shortsv1alpha1.GetRegisterActivityResponse{},
		&shortsv1alpha1.WeeklyEventCount{},
		&shortsv1alpha1.ActiveMember{},
		&shortsv1alpha1.NewlyDeclaredCompany{},
		&shortsv1alpha1.DeclarerCountChange{},
		&shortsv1alpha1.ListDistinctiveHoldingsResponse{},
		&shortsv1alpha1.DistinctiveHolding{},
	}
	for _, message := range messages {
		descriptor := message.ProtoReflect().Descriptor()
		fields := descriptor.Fields()
		for _, name := range banned {
			if fields.ByName(protoreflect.Name(name)) != nil {
				t.Errorf("%s carries editorially forbidden field %q", descriptor.FullName(), name)
			}
		}
		// short_percent is the ONE permitted percentage, and only because it
		// describes THE COMPANY (ASIC, market-wide) and travels with a
		// mandatory disclosure. Assert it stays on the one message entitled to
		// it rather than spreading.
		if fields.ByName("short_percent") != nil && descriptor.Name() != "DistinctiveHolding" {
			t.Errorf("%s carries short_percent; only DistinctiveHolding may, and only with its disclosure", descriptor.FullName())
		}
	}
}

// The filters are additive: an unfiltered request must reach the store with
// every filter empty, and a filtered one must arrive normalised.
func TestListRegisterChangesNormalisesDiscoveryFiltersBeforeStoreAndCache(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	server := newTestServer(t, store)

	overview := &shortsstore.RegisterOverviewRow{AsAt: time.Date(2026, 7, 21, 0, 0, 0, 0, time.UTC)}

	// Unfiltered: the pre-existing behaviour, unchanged.
	store.EXPECT().ListRegisterChanges(gomock.Any(), "", "", "", int32(0), "", "", int32(100), int32(0)).
		Return(nil, int32(0), nil).Times(1)
	store.EXPECT().GetRegisterOverview().Return(overview, nil).Times(1)
	if _, err := server.ListRegisterChanges(t.Context(),
		connect.NewRequest(&shortsv1alpha1.ListRegisterChangesRequest{})); err != nil {
		t.Fatalf("unfiltered: %v", err)
	}

	// Filtered: slug lower-cased, party upper-cased, chamber lower-cased, and
	// an out-of-range item collapsed to 0 ("all") rather than reaching a query.
	store.EXPECT().ListRegisterChanges(gomock.Any(), "added", "CBA", "alice-example", int32(0), "ALP", "senate", int32(500), int32(0)).
		Return([]*shortsstore.RegisterChangeRow{{
			Politician: &shortsstore.PoliticianRow{Slug: "alice-example"},
			Kind:       "added", ItemNo: 1, StockCode: "CBA",
		}}, int32(1), nil).Times(1)
	store.EXPECT().GetRegisterOverview().Return(overview, nil).Times(1)

	resp, err := server.ListRegisterChanges(t.Context(), connect.NewRequest(&shortsv1alpha1.ListRegisterChangesRequest{
		Kind:           shortsv1alpha1.RegisterChangeKind_REGISTER_CHANGE_KIND_ADDED,
		StockCode:      " cba ",
		PoliticianSlug: " ALICE-EXAMPLE ",
		ItemNo:         99,
		PartyAb:        " alp ",
		Chamber:        " SENATE ",
		Limit:          5000,
	}))
	if err != nil {
		t.Fatalf("filtered: %v", err)
	}
	if len(resp.Msg.GetEvents()) != 1 || resp.Msg.GetTotal() != 1 {
		t.Fatalf("filtered feed = %v", resp.Msg)
	}
	if resp.Msg.GetAsAt() == nil || !resp.Msg.GetAsAt().AsTime().Equal(overview.AsAt) {
		t.Errorf("asAt = %v, want the newest lodgement", resp.Msg.GetAsAt())
	}

	// Repeating the normalised request is served from cache — no third store
	// call is permitted for either method.
	if _, err := server.ListRegisterChanges(t.Context(), connect.NewRequest(&shortsv1alpha1.ListRegisterChangesRequest{
		Kind: shortsv1alpha1.RegisterChangeKind_REGISTER_CHANGE_KIND_ADDED, StockCode: "CBA",
		PoliticianSlug: "alice-example", PartyAb: "ALP", Chamber: "senate", Limit: 500,
	})); err != nil {
		t.Fatalf("cached filtered call: %v", err)
	}
}

// Distinct filter sets must not collide on one cache key, or one filtered feed
// would be served for another.
func TestRegisterChangesCacheKeyIncludesTheNewFilters(t *testing.T) {
	cache := NewMemoryCache(time.Minute)
	when := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	base := cache.ListRegisterChangesKey(when, "added", "", "", 0, "", "", 100, 0)
	variants := map[string]string{
		"slug":    cache.ListRegisterChangesKey(when, "added", "", "alice-example", 0, "", "", 100, 0),
		"item_no": cache.ListRegisterChangesKey(when, "added", "", "", 3, "", "", 100, 0),
		"party":   cache.ListRegisterChangesKey(when, "added", "", "", 0, "ALP", "", 100, 0),
		"chamber": cache.ListRegisterChangesKey(when, "added", "", "", 0, "", "senate", 100, 0),
	}
	for name, key := range variants {
		if key == base {
			t.Errorf("%s filter does not change the cache key", name)
		}
	}
	if cache.GetRegisterActivityKey(30) == cache.GetRegisterActivityKey(90) {
		t.Error("activity windows must not share a cache key")
	}
}
