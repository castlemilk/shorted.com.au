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

func TestExplorerRPCsKillSwitchReturnEmptyNotError(t *testing.T) {
	t.Setenv("POLITICIAN_INTERESTS_ENABLED", "false")
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	server := newTestServer(t, store)

	explorer, err := server.GetRegisterExplorer(t.Context(),
		connect.NewRequest(&shortsv1alpha1.GetRegisterExplorerRequest{}))
	if err != nil || explorer.Msg.GetSourceLicence() != "" || explorer.Msg.GetAsAt() != nil {
		t.Fatalf("GetRegisterExplorer kill switch = (%v, %v), want empty response", explorer, err)
	}

	summaries, err := server.ListPoliticianSummaries(t.Context(),
		connect.NewRequest(&shortsv1alpha1.ListPoliticianSummariesRequest{}))
	if err != nil || len(summaries.Msg.GetSummaries()) != 0 || summaries.Msg.GetTotal() != 0 {
		t.Fatalf("ListPoliticianSummaries kill switch = (%v, %v), want empty response", summaries, err)
	}

	profile, err := server.GetPoliticianExplorerProfile(t.Context(),
		connect.NewRequest(&shortsv1alpha1.GetPoliticianExplorerProfileRequest{Slug: "alice"}))
	if err != nil || profile.Msg.GetPolitician() != nil || profile.Msg.GetCanonicalSlug() != "" {
		t.Fatalf("GetPoliticianExplorerProfile kill switch = (%v, %v), want empty response", profile, err)
	}

	comparison, err := server.ComparePoliticians(t.Context(),
		connect.NewRequest(&shortsv1alpha1.ComparePoliticiansRequest{SlugA: "alice", SlugB: "bob"}))
	if err != nil || comparison.Msg.GetA() != nil || comparison.Msg.GetB() != nil {
		t.Fatalf("ComparePoliticians kill switch = (%v, %v), want empty response", comparison, err)
	}
}

func TestListPoliticianSummariesNormalisesFiltersBeforeStoreAndCache(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	server := newTestServer(t, store)

	store.EXPECT().ListPoliticianSummaries(
		"house", "NSW", "ALP", int32(3), "alice", "declared_items", int32(200), int32(0),
	).Return([]*shortsstore.PoliticianSummaryRow{
		{
			Politician:           &shortsstore.PoliticianRow{Slug: "alice-example", DisplayName: "Alice Example"},
			ItemCounts:           []*shortsstore.RegisterItemCountRow{{ItemNo: 1, ItemLabel: "Shareholdings", CurrentCount: 2, AllTimeCount: 3}},
			DistinctCompanyCount: 2,
			PropertyCount:        1,
			GiftsTravelCount:     0,
			LiabilityCount:       1,
			Changes90d:           2,
			Trend:                []*shortsstore.RegisterMonthlyCountRow{{Month: "2026-07", DeclaredCount: 2}},
			UndatedCount:         1,
		},
	}, int32(1), nil).Times(1)

	request := &shortsv1alpha1.ListPoliticianSummariesRequest{
		Chamber:   " HOUSE ",
		StateCode: " nsw ",
		PartyAb:   " alp ",
		ItemNo:    3,
		Query:     "  alice ",
		Sort:      shortsv1alpha1.PoliticianSummarySort_POLITICIAN_SUMMARY_SORT_DECLARED_ITEMS,
		Limit:     999,
		Offset:    -4,
	}
	first, err := server.ListPoliticianSummaries(t.Context(), connect.NewRequest(request))
	if err != nil {
		t.Fatalf("first ListPoliticianSummaries: %v", err)
	}
	second, err := server.ListPoliticianSummaries(t.Context(), connect.NewRequest(&shortsv1alpha1.ListPoliticianSummariesRequest{
		Chamber: "house", StateCode: "NSW", PartyAb: "ALP", ItemNo: 3, Query: "alice",
		Sort:  shortsv1alpha1.PoliticianSummarySort_POLITICIAN_SUMMARY_SORT_DECLARED_ITEMS,
		Limit: 200, Offset: 0,
	}))
	if err != nil {
		t.Fatalf("second ListPoliticianSummaries: %v", err)
	}
	if first.Msg.GetTotal() != 1 || second.Msg.GetTotal() != 1 {
		t.Fatalf("total = (%d, %d), want 1", first.Msg.GetTotal(), second.Msg.GetTotal())
	}
	if got := first.Msg.GetSummaries()[0].GetItemCounts()[0].GetAllTimeCount(); got != 3 {
		t.Errorf("all-time item count = %d, want 3", got)
	}
}

// Politician.declared_listed_count / declared_property_count are ALL-TIME
// counts everywhere else in the API, and the summary must carry them unchanged
// rather than overwriting them with its currently-declared figures: the same
// person reporting two different numbers depending on the rpc is a factual
// defect, and /politicians/[slug] gates indexability on declaredListedCount > 0.
// The currently-declared figures ride on the summary's own fields.
func TestPoliticianSummaryKeepsAllTimeAndCurrentCountsApart(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	server := newTestServer(t, store)

	store.EXPECT().ListPoliticianSummaries("", "", "", int32(0), "", "declared_items", int32(50), int32(0)).
		Return([]*shortsstore.PoliticianSummaryRow{
			{
				Politician: &shortsstore.PoliticianRow{
					Slug: "james-stevens", DisplayName: "James Stevens",
					// All-time: nine companies declared across the record.
					DeclaredListedCount: 9, DeclaredPropertyCount: 2,
				},
				// Currently declared: none of the nine, and three item-3 entries
				// whose suburbs never resolved.
				DistinctCompanyCount: 0,
				PropertyCount:        3,
				ItemCounts:           []*shortsstore.RegisterItemCountRow{{ItemNo: 3, CurrentCount: 3, AllTimeCount: 5}},
			},
		}, int32(1), nil).Times(1)

	response, err := server.ListPoliticianSummaries(t.Context(),
		connect.NewRequest(&shortsv1alpha1.ListPoliticianSummariesRequest{}))
	if err != nil {
		t.Fatalf("ListPoliticianSummaries: %v", err)
	}
	summary := response.Msg.GetSummaries()[0]
	if got := summary.GetPolitician().GetDeclaredListedCount(); got != 9 {
		t.Errorf("declared_listed_count = %d, want the all-time 9 every other rpc reports", got)
	}
	if got := summary.GetPolitician().GetDeclaredPropertyCount(); got != 2 {
		t.Errorf("declared_property_count = %d, want the all-time 2", got)
	}
	if got := summary.GetDistinctCompanyCount(); got != 0 {
		t.Errorf("summary distinct_company_count = %d, want the currently-declared 0", got)
	}
	// Properties are declared item-3 entries; an unresolved suburb does not
	// erase a declaration.
	if got := summary.GetPropertyCount(); got != 3 {
		t.Errorf("summary property_count = %d, want the 3 currently-declared item-3 entries", got)
	}
}

// The two clocks that must never be confused: `lodged` is the newest lodgement
// the REGISTER carries, `refreshed` is when WE last rebuilt the snapshot. The
// proto defines as_at as the former. They are ten days apart on the dev corpus,
// and a nightly refresh over an unchanged register keeps widening the gap.
var (
	registerLodgementMax = time.Date(2026, 7, 21, 0, 0, 0, 0, time.UTC)
	registerRefreshedAt  = time.Date(2026, 7, 31, 4, 28, 34, 0, time.UTC)
)

func TestListPoliticianSummariesEmptyPageStillCarriesSnapshotMetadata(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	server := newTestServer(t, store)

	store.EXPECT().ListPoliticianSummaries("", "", "", int32(0), "nobody", "declared_items", int32(50), int32(0)).Return(nil, int32(0), nil)
	store.EXPECT().GetRegisterOverview().Return(&shortsstore.RegisterOverviewRow{
		AsAt: registerLodgementMax, RefreshedAt: registerRefreshedAt,
	}, nil)

	response, err := server.ListPoliticianSummaries(t.Context(), connect.NewRequest(
		&shortsv1alpha1.ListPoliticianSummariesRequest{Query: "nobody"},
	))
	if err != nil {
		t.Fatalf("empty ListPoliticianSummaries: %v", err)
	}
	if response.Msg.GetAsAt() == nil || !response.Msg.GetAsAt().AsTime().Equal(registerLodgementMax) {
		t.Fatalf("empty page asAt = %v, want the newest lodgement %v", response.Msg.GetAsAt(), registerLodgementMax)
	}
	if response.Msg.GetAsAt().AsTime().Equal(registerRefreshedAt) {
		t.Fatal("empty page asAt fell back to our snapshot-rebuild clock")
	}
	if response.Msg.GetSourceLicence() == "" {
		t.Fatal("empty page lost source licence")
	}
}

// as_at is "the newest lodgement we hold" (politicians.proto), which every
// surface renders as "Register of Members' Interests, as at DATE" beside named
// members. Serving max(refreshed_at) there claimed currency we do not have — it
// advances every night the snapshot rebuilds, even over an unchanged register.
func TestRegisterExplorerAsAtIsTheNewestLodgementNotOurRefresh(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	server := newTestServer(t, store)

	// The row's own as-at is left ZERO on purpose: this exercises the overview
	// fallback, which is the line that used to reach for RefreshedAt.
	store.EXPECT().GetRegisterExplorer().Return(&shortsstore.RegisterExplorerRow{
		Overview: &shortsstore.RegisterOverviewRow{
			PoliticianCount: 323,
			AsAt:            registerLodgementMax,
			RefreshedAt:     registerRefreshedAt,
		},
	}, nil)

	response, err := server.GetRegisterExplorer(t.Context(),
		connect.NewRequest(&shortsv1alpha1.GetRegisterExplorerRequest{}))
	if err != nil {
		t.Fatalf("GetRegisterExplorer: %v", err)
	}
	if response.Msg.GetAsAt() == nil {
		t.Fatal("as_at is unset even though the register carries a lodgement date")
	}
	if got := response.Msg.GetAsAt().AsTime(); !got.Equal(registerLodgementMax) {
		t.Fatalf("as_at = %v, want the newest lodgement %v (refresh clock is %v)",
			got, registerLodgementMax, registerRefreshedAt)
	}
}

// The compare page names two members side by side, so its as-at is the most
// load-bearing one in the subsystem: it dates a statement about what two
// specific people declared.
func TestComparePoliticiansAsAtIsTheNewestLodgement(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	server := newTestServer(t, store)

	store.EXPECT().ComparePoliticians("alice-example", "bob-example").Return(&shortsstore.PoliticianComparisonRow{
		SummaryA: &shortsstore.PoliticianSummaryRow{Politician: &shortsstore.PoliticianRow{Slug: "alice-example"}},
		SummaryB: &shortsstore.PoliticianSummaryRow{Politician: &shortsstore.PoliticianRow{Slug: "bob-example"}},
		AsAt:     registerLodgementMax,
	}, nil)

	response, err := server.ComparePoliticians(t.Context(), connect.NewRequest(
		&shortsv1alpha1.ComparePoliticiansRequest{SlugA: "alice-example", SlugB: "bob-example"}))
	if err != nil {
		t.Fatalf("ComparePoliticians: %v", err)
	}
	if response.Msg.GetAsAt() == nil || !response.Msg.GetAsAt().AsTime().Equal(registerLodgementMax) {
		t.Fatalf("compare as_at = %v, want the newest lodgement %v", response.Msg.GetAsAt(), registerLodgementMax)
	}
}

func TestGetPoliticianMapsTerms(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	server := newTestServer(t, store)

	store.EXPECT().GetPolitician("alice-example").Return(
		&shortsstore.PoliticianRow{
			Slug: "alice-example", DisplayName: "Alice Example",
			Terms: []*shortsstore.PoliticianTermRow{{Parliament: 48, Chamber: "house", Division: "Example", StateCode: "NSW", Party: "Australian Labor Party", PartyAb: "ALP"}},
		}, nil, nil, nil,
	)

	response, err := server.GetPolitician(t.Context(), connect.NewRequest(&shortsv1alpha1.GetPoliticianRequest{Slug: "alice-example"}))
	if err != nil {
		t.Fatalf("GetPolitician: %v", err)
	}
	if len(response.Msg.GetTerms()) != 1 || response.Msg.GetTerms()[0].GetParliament() != 48 || response.Msg.GetTerms()[0].GetParty() != "Australian Labor Party" {
		t.Fatalf("terms = %v, want the stored term", response.Msg.GetTerms())
	}
}

func TestExplorerMappersPreserveProfileAndCompareFacts(t *testing.T) {
	profile := &shortsstore.PoliticianExplorerProfileRow{
		Politician:      &shortsstore.PoliticianRow{Slug: "alice-example", DisplayName: "Alice Example"},
		CanonicalSlug:   "alice-example",
		ItemCounts:      []*shortsstore.RegisterItemCountRow{{ItemNo: 1, CurrentCount: 2, AllTimeCount: 4}},
		HolderCounts:    []*shortsstore.RegisterHolderCountRow{{Holder: "spouse_partner", CurrentCount: 1}},
		IndustryCounts:  []*shortsstore.RegisterIndustryCountRow{{Industry: "Banks", CompanyCount: 2}},
		Timeline:        []*shortsstore.RegisterMonthlyCountRow{{Month: "2026-07", DeclaredCount: 2}},
		UndatedCount:    3,
		SourceDocuments: []*shortsstore.RegisterSourceDocumentRow{{Label: "Volume A", SourceURL: "https://www.aph.gov.au/example.pdf", Parliament: 48, Chamber: "house"}},
	}
	gotProfile := politicianExplorerProfileProto(profile)
	if gotProfile.GetCanonicalSlug() != "alice-example" || gotProfile.GetItemCounts()[0].GetAllTimeCount() != 4 || gotProfile.GetUndatedCount() != 3 {
		t.Fatalf("profile mapper lost facts: %v", gotProfile)
	}
	if gotProfile.GetHolderCounts()[0].GetHolder() != shortsv1alpha1.RegisterHolder_REGISTER_HOLDER_SPOUSE_PARTNER {
		t.Fatalf("profile holder mapper = %v", gotProfile.GetHolderCounts())
	}

	comparison := &shortsstore.PoliticianComparisonRow{
		SummaryA:        &shortsstore.PoliticianSummaryRow{Politician: &shortsstore.PoliticianRow{Slug: "alice-example"}},
		SummaryB:        &shortsstore.PoliticianSummaryRow{Politician: &shortsstore.PoliticianRow{Slug: "bob-example"}},
		SharedCompanies: []*shortsstore.SharedDeclaredCompanyRow{{StockCode: "CBA", HoldersA: []string{"self"}, HoldersB: []string{"spouse_partner"}, CurrentlyDeclaredA: true}},
		OnlyCompaniesA:  []*shortsstore.PoliticianOnlyCompanyRow{{StockCode: "BHP", Holders: []string{"self"}, CurrentlyDeclared: true}},
		OnlyAMore:       2,
	}
	gotCompare := comparePoliticiansProto(comparison)
	if len(gotCompare.GetSharedCompanies()) != 1 || len(gotCompare.GetOnlyACompanies()) != 1 || gotCompare.GetOnlyAMore() != 2 {
		t.Fatalf("compare mapper lost company sets: %v", gotCompare)
	}

	fields := (&shortsv1alpha1.ComparePoliticiansResponse{}).ProtoReflect().Descriptor().Fields()
	for _, banned := range []string{"score", "winner", "ranking", "advantage", "lead"} {
		if fields.ByName(protoreflect.Name(banned)) != nil {
			t.Fatalf("compare response contains editorially forbidden field %q", banned)
		}
	}
}

func TestExplorerHandlersClampProfileAndNormaliseCompareInputs(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	server := newTestServer(t, store)

	store.EXPECT().GetPoliticianExplorerProfile("alice-example", int32(20)).Return(
		&shortsstore.PoliticianExplorerProfileRow{
			Politician:    &shortsstore.PoliticianRow{Slug: "alice-example", DisplayName: "Alice Example"},
			CanonicalSlug: "alice-example",
		}, nil,
	).Times(1)
	firstProfile, err := server.GetPoliticianExplorerProfile(t.Context(), connect.NewRequest(
		&shortsv1alpha1.GetPoliticianExplorerProfileRequest{Slug: " ALICE-EXAMPLE ", TopIndustries: 999},
	))
	if err != nil {
		t.Fatalf("first profile: %v", err)
	}
	secondProfile, err := server.GetPoliticianExplorerProfile(t.Context(), connect.NewRequest(
		&shortsv1alpha1.GetPoliticianExplorerProfileRequest{Slug: "alice-example", TopIndustries: 20},
	))
	if err != nil || firstProfile.Msg.GetCanonicalSlug() != secondProfile.Msg.GetCanonicalSlug() {
		t.Fatalf("normalised profile cache call = (%v, %v)", secondProfile, err)
	}

	store.EXPECT().ComparePoliticians("alice-example", "bob-example").Return(
		&shortsstore.PoliticianComparisonRow{
			SummaryA: &shortsstore.PoliticianSummaryRow{Politician: &shortsstore.PoliticianRow{Slug: "alice-example"}},
			SummaryB: &shortsstore.PoliticianSummaryRow{Politician: &shortsstore.PoliticianRow{Slug: "bob-example"}},
		}, nil,
	).Times(1)
	firstCompare, err := server.ComparePoliticians(t.Context(), connect.NewRequest(
		&shortsv1alpha1.ComparePoliticiansRequest{SlugA: " ALICE-EXAMPLE ", SlugB: " BOB-EXAMPLE "},
	))
	if err != nil {
		t.Fatalf("first compare: %v", err)
	}
	secondCompare, err := server.ComparePoliticians(t.Context(), connect.NewRequest(
		&shortsv1alpha1.ComparePoliticiansRequest{SlugA: "alice-example", SlugB: "bob-example"},
	))
	if err != nil || firstCompare.Msg.GetA().GetPolitician().GetSlug() != secondCompare.Msg.GetA().GetPolitician().GetSlug() {
		t.Fatalf("normalised compare cache call = (%v, %v)", secondCompare, err)
	}
}

// A member compared with themself produced a WRONG PAGE, not an empty one: the
// side-attribution keys on count(DISTINCT slug) = 2, so with one slug on both
// sides every holding fell through to only_a and the compare surface reported
// that the member shares nothing with themself while listing their own holdings
// as the difference between them. It must be refused before it reaches a query.
func TestComparePoliticiansRejectsAMemberAgainstThemself(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	server := newTestServer(t, store)

	// No store call is permitted for any of these — the mock has no EXPECT.
	for _, pair := range [][2]string{
		{"alice-example", "alice-example"},
		{" ALICE-EXAMPLE ", "alice-example"}, // same person after normalisation
	} {
		_, err := server.ComparePoliticians(t.Context(), connect.NewRequest(
			&shortsv1alpha1.ComparePoliticiansRequest{SlugA: pair[0], SlugB: pair[1]},
		))
		if connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("ComparePoliticians(%q, %q): code = %v, want InvalidArgument", pair[0], pair[1], connect.CodeOf(err))
		}
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
	if cache.ListRegisterChangesKey(a, "added", "CBA", "", 0, "", "", 100, 0) != cache.ListRegisterChangesKey(b, "added", "CBA", "", 0, "", "", 100, 0) {
		t.Error("keys differ for the same day; the cache would never hit")
	}
	other := time.Date(2026, 7, 2, 9, 30, 0, 0, time.UTC)
	if cache.ListRegisterChangesKey(a, "added", "CBA", "", 0, "", "", 100, 0) == cache.ListRegisterChangesKey(other, "added", "CBA", "", 0, "", "", 100, 0) {
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
