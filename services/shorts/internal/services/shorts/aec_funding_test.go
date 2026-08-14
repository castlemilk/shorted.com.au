package shorts

// Handler tests for the AEC funding layer.
//
// What these protect is not the plumbing — it is the four editorial properties
// that make publishing amounts beside a politician's name defensible at all:
// the notes always ship, the kill switch degrades instead of breaking, the
// clamping keeps a cache key honest, and no member response can carry money
// that was not lodged in that member's name.

import (
	"strings"
	"testing"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"github.com/jackc/pgx/v5"
	"go.uber.org/mock/gomock"
)

// The kill switch returns EMPTY, never an error, on all four rpcs — the same
// contract the register's switch has, so a funding dispute takes the funding
// surfaces down without breaking the pages that host them.
//
// It is also independent of POLITICIAN_INTERESTS_ENABLED: a dispute about a
// donation figure must not be able to take the register of interests down.
func TestFundingRPCsKillSwitchReturnEmptyNotError(t *testing.T) {
	t.Setenv("AEC_DONATIONS_ENABLED", "false")
	ctrl := gomock.NewController(t)
	// No EXPECT at all: a store call under the kill switch is a failure.
	store := mocks.NewMockShortsStore(ctrl)
	server := newTestServer(t, store)

	overview, err := server.GetDonationsOverview(t.Context(),
		connect.NewRequest(&shortsv1alpha1.GetDonationsOverviewRequest{FinancialYear: "2024-25"}))
	if err != nil || len(overview.Msg.GetParties()) != 0 || overview.Msg.GetSourceLicence() != "" ||
		overview.Msg.GetCensoringNote() != "" || overview.Msg.GetAsAt() != nil {
		t.Fatalf("GetDonationsOverview kill switch = (%v, %v), want an empty response", overview, err)
	}

	donors, err := server.ListTopDonors(t.Context(),
		connect.NewRequest(&shortsv1alpha1.ListTopDonorsRequest{FinancialYear: "2024-25"}))
	if err != nil || len(donors.Msg.GetDonors()) != 0 || donors.Msg.GetTotal() != 0 ||
		donors.Msg.GetSourceLicence() != "" {
		t.Fatalf("ListTopDonors kill switch = (%v, %v), want an empty response", donors, err)
	}

	party, err := server.ListPartyFunding(t.Context(),
		connect.NewRequest(&shortsv1alpha1.ListPartyFundingRequest{PartyGroup: "Liberal"}))
	if err != nil || len(party.Msg.GetSeries()) != 0 || party.Msg.GetSourceLicence() != "" {
		t.Fatalf("ListPartyFunding kill switch = (%v, %v), want an empty response", party, err)
	}

	funding, err := server.GetPoliticianFunding(t.Context(),
		connect.NewRequest(&shortsv1alpha1.GetPoliticianFundingRequest{Slug: "monique-ryan"}))
	if err != nil || len(funding.Msg.GetAnnualReturns()) != 0 ||
		len(funding.Msg.GetCandidateReturns()) != 0 || funding.Msg.GetCoverageNote() != "" {
		t.Fatalf("GetPoliticianFunding kill switch = (%v, %v), want an empty response", funding, err)
	}
}

// The switch defaults ON. Nobody has to set an env var to ship this, and the
// only reason to set it is to take the surface down.
func TestAECDonationsEnabledDefaultsOn(t *testing.T) {
	t.Setenv("AEC_DONATIONS_ENABLED", "")
	if !aecDonationsEnabled() {
		t.Fatal("aecDonationsEnabled() = false with the env unset, want the default ON")
	}
	for _, off := range []string{"false", "FALSE", "0", "off", "no", " No "} {
		t.Setenv("AEC_DONATIONS_ENABLED", off)
		if aecDonationsEnabled() {
			t.Errorf("aecDonationsEnabled() = true for %q, want off", off)
		}
	}
	for _, on := range []string{"true", "1", "yes", "anything"} {
		t.Setenv("AEC_DONATIONS_ENABLED", on)
		if !aecDonationsEnabled() {
			t.Errorf("aecDonationsEnabled() = false for %q, want on", on)
		}
	}
}

// Every response carries the licence, the Crown-copyright attribution and the
// three notes — served WITH the amounts rather than left to a page footer a
// consumer can forget. An overview of party totals with no censoring caveat is
// the single most misleading artefact this data can produce.
func TestFundingResponsesAlwaysCarryLicenceAndNotes(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	server := newTestServer(t, store)

	// Deliberately EMPTY store results: the notes must ship even when there is
	// nothing to caveat, because a surface rendering nothing still has to be
	// able to say what nothing means.
	store.EXPECT().GetDonationsOverview("", int32(25)).Return(&shortsstore.DonationsOverviewRow{}, nil)
	store.EXPECT().ListTopDonors("", "", int32(50), int32(0)).Return(&shortsstore.TopDonorsRow{}, nil)
	store.EXPECT().ListPartyFunding("Liberal", "", int32(25)).Return(&shortsstore.PartyFundingDetailRow{}, nil)
	store.EXPECT().GetPoliticianFunding("alice-example").Return(&shortsstore.PoliticianFundingRow{}, nil)

	overview, err := server.GetDonationsOverview(t.Context(),
		connect.NewRequest(&shortsv1alpha1.GetDonationsOverviewRequest{}))
	if err != nil {
		t.Fatalf("GetDonationsOverview: %v", err)
	}
	m := overview.Msg
	if m.GetSourceLicence() != aecLicence || m.GetAttribution() != aecAttribution {
		t.Errorf("overview licence/attribution = (%q, %q), want (%q, %q)",
			m.GetSourceLicence(), m.GetAttribution(), aecLicence, aecAttribution)
	}
	if m.GetCensoringNote() == "" || m.GetReformNote() == "" ||
		m.GetCoverageNote() == "" || m.GetVerbatimNote() == "" {
		t.Error("overview must carry the censoring, reform, coverage and verbatim notes")
	}

	donors, err := server.ListTopDonors(t.Context(),
		connect.NewRequest(&shortsv1alpha1.ListTopDonorsRequest{}))
	if err != nil {
		t.Fatalf("ListTopDonors: %v", err)
	}
	if donors.Msg.GetSourceLicence() != aecLicence || donors.Msg.GetAttribution() != aecAttribution ||
		donors.Msg.GetScopeNote() == "" || donors.Msg.GetCensoringNote() == "" ||
		donors.Msg.GetReformNote() == "" || donors.Msg.GetVerbatimNote() == "" {
		t.Error("top donors must carry the licence, attribution, scope and the three notes")
	}

	party, err := server.ListPartyFunding(t.Context(),
		connect.NewRequest(&shortsv1alpha1.ListPartyFundingRequest{PartyGroup: " Liberal "}))
	if err != nil {
		t.Fatalf("ListPartyFunding: %v", err)
	}
	if party.Msg.GetSourceLicence() != aecLicence || party.Msg.GetAttribution() != aecAttribution ||
		party.Msg.GetCensoringNote() == "" || party.Msg.GetReformNote() == "" ||
		party.Msg.GetVerbatimNote() == "" {
		t.Error("party funding must carry the licence, attribution and the three notes")
	}

	funding, err := server.GetPoliticianFunding(t.Context(),
		connect.NewRequest(&shortsv1alpha1.GetPoliticianFundingRequest{Slug: "Alice-Example"}))
	if err != nil {
		t.Fatalf("GetPoliticianFunding: %v", err)
	}
	// The two that matter most on a member page: the coverage sentence (this
	// layer is thin — 52 returns in the whole corpus) and the attribution
	// sentence (party money is not this person's money). Both must be present
	// on an EMPTY response, which is exactly when a reader is most likely to
	// misread absence as evidence.
	if funding.Msg.GetCoverageNote() == "" || funding.Msg.GetAttributionNote() == "" {
		t.Error("politician funding must carry the coverage and attribution notes even when empty")
	}
	if funding.Msg.GetSourceLicence() != aecLicence || funding.Msg.GetAttribution() != aecAttribution {
		t.Error("politician funding must carry the licence and attribution")
	}
}

// The coverage note must name senator returns and state the SIZE of the corpus.
// 11 of the 52 annual returns are senators', and a surface that does not say
// how thin the whole layer is implies the absence of a return is evidence about
// the person who did not lodge one.
//
// IT NO LONGER DEMANDS THE PHRASE "not yet linked". That phrase described a
// real limitation — the politicians table was House-only, so no senator return
// could resolve — and register-senators removed it. Asserting the wording of a
// limitation that no longer holds would force the copy to keep saying something
// untrue; the size disclosure is the part that is permanently required, so that
// is what this asserts. The replacement copy belongs with the rest of the web
// wave's wording.
func TestMemberCoverageNoteStatesItsCoverage(t *testing.T) {
	if !containsFold(aecMemberCoverageNote, "senator") {
		t.Errorf("coverage note does not mention senator returns: %q", aecMemberCoverageNote)
	}
	if !containsFold(aecMemberCoverageNote, "52") {
		t.Errorf("coverage note does not state the size of the member layer: %q", aecMemberCoverageNote)
	}
	if !containsFold(aecMemberCoverageNote, "has not been shown") {
		t.Errorf("coverage note does not say that a missing return is not evidence: %q", aecMemberCoverageNote)
	}
	// THE NEW LOCKED SUBSTANCE, and the reason this note was rewritten.
	//
	// Senator returns resolve now, so a senator's profile can carry a funding
	// figure while its register section is empty — because the Registers of
	// Senators' Interests have not been read into this site. A funding total
	// standing alone under an empty register reads as everything we hold about
	// that person; the note has to say the register is UNREAD, and that the gap
	// is ours. Both halves are asserted by substance, never by phrasing.
	if !containsFold(aecMemberCoverageNote, "not been read") {
		t.Errorf("coverage note does not say the senate registers are unread: %q", aecMemberCoverageNote)
	}
	if !containsFold(aecMemberCoverageNote, "coverage") {
		t.Errorf("coverage note does not name the gap as ours: %q", aecMemberCoverageNote)
	}
	// And the verbatim note has to say the figures are as lodged and can move.
	if !containsFold(aecVerbatimNote, "as lodged") {
		t.Errorf("verbatim note does not state the figures are as lodged: %q", aecVerbatimNote)
	}
}

// The notes must not smuggle in causal or influence vocabulary. This is the
// funding-specific arm of the editorial standards' banned-word sweep: these
// strings are rendered verbatim on every funding surface, so a single word here
// propagates everywhere at once.
func TestFundingNotesUseNoCausalVocabulary(t *testing.T) {
	banned := []string{
		"influence", "buy", "bought", "bribe", "corrupt", "capture", "captured",
		"in exchange", "in return for", "reward", "payback", "favour", "favor",
		"quid pro quo", "access to power", "beholden",
	}
	notes := map[string]string{
		"censoring":    aecCensoringNote,
		"reform":       aecReformNote,
		"coverage":     aecMemberCoverageNote,
		"attribution":  aecAttributionNote,
		"verbatim":     aecVerbatimNote,
		"donor scope":  aecDonorScopeNote,
		"attribution2": aecAttribution,
	}
	for name, note := range notes {
		for _, word := range banned {
			if containsFold(note, word) {
				t.Errorf("%s note contains banned vocabulary %q: %q", name, word, note)
			}
		}
	}
}

// Limits and offsets are clamped BEFORE the cache key is built, so a key can
// never describe a page other than the one whose result it holds. Two requests
// that clamp to the same page must therefore share ONE store call.
func TestFundingHandlersClampBeforeStoreAndCache(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	server := newTestServer(t, store)

	// 0 and 500 both clamp to the same page (default 50 / max 200 respectively
	// are different, so these are two separate expectations), and a negative
	// offset floors at 0.
	store.EXPECT().ListTopDonors("2024-25", "", int32(50), int32(0)).
		Return(&shortsstore.TopDonorsRow{FinancialYear: "2024-25"}, nil).Times(1)
	store.EXPECT().ListTopDonors("2024-25", "", int32(200), int32(0)).
		Return(&shortsstore.TopDonorsRow{FinancialYear: "2024-25"}, nil).Times(1)

	for _, req := range []*shortsv1alpha1.ListTopDonorsRequest{
		{FinancialYear: "2024-25", Limit: 0, Offset: -5},
		{FinancialYear: " 2024-25 ", Limit: 0, Offset: 0}, // trimmed to the same key
		{FinancialYear: "2024-25", Limit: -1, Offset: -100},
	} {
		if _, err := server.ListTopDonors(t.Context(), connect.NewRequest(req)); err != nil {
			t.Fatalf("ListTopDonors(%v): %v", req, err)
		}
	}
	for _, limit := range []int32{500, 201, 200} {
		if _, err := server.ListTopDonors(t.Context(), connect.NewRequest(
			&shortsv1alpha1.ListTopDonorsRequest{FinancialYear: "2024-25", Limit: limit})); err != nil {
			t.Fatalf("ListTopDonors(limit=%d): %v", limit, err)
		}
	}

	// The overview's own bounds: default 25, max 100.
	store.EXPECT().GetDonationsOverview("2024-25", int32(25)).
		Return(&shortsstore.DonationsOverviewRow{}, nil).Times(1)
	store.EXPECT().GetDonationsOverview("2024-25", int32(100)).
		Return(&shortsstore.DonationsOverviewRow{}, nil).Times(1)
	for _, limit := range []int32{0, -3, 25} {
		if _, err := server.GetDonationsOverview(t.Context(), connect.NewRequest(
			&shortsv1alpha1.GetDonationsOverviewRequest{FinancialYear: "2024-25", Limit: limit})); err != nil {
			t.Fatalf("GetDonationsOverview(limit=%d): %v", limit, err)
		}
	}
	for _, limit := range []int32{100, 101, 9999} {
		if _, err := server.GetDonationsOverview(t.Context(), connect.NewRequest(
			&shortsv1alpha1.GetDonationsOverviewRequest{FinancialYear: "2024-25", Limit: limit})); err != nil {
			t.Fatalf("GetDonationsOverview(limit=%d): %v", limit, err)
		}
	}
}

// The financial-year label is VERBATIM from the source: '2011-12' in some years
// and '1998-1999' in others. Trimming is the only normalisation that is safe —
// case-folding or reformatting would invent a label the corpus does not hold.
func TestFinancialYearNormalisationOnlyTrims(t *testing.T) {
	for in, want := range map[string]string{
		"  2024-25 ": "2024-25",
		"1998-1999":  "1998-1999",
		"":           "",
		"  ":         "",
	} {
		if got := normaliseFinancialYear(in); got != want {
			t.Errorf("normaliseFinancialYear(%q) = %q, want %q", in, got, want)
		}
	}
}

// The party group is the source's own verbatim key ('The Greens', 'Country
// Liberal Party (NT)'), so it is trimmed and NOT case-folded — folding it would
// fail every lookup — and an empty one is rejected rather than silently
// serving some other party's series.
func TestListPartyFundingRequiresAPartyGroup(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	server := newTestServer(t, store)

	if _, err := server.ListPartyFunding(t.Context(), connect.NewRequest(
		&shortsv1alpha1.ListPartyFundingRequest{PartyGroup: "   "})); err == nil {
		t.Fatal("ListPartyFunding with a blank party group returned no error")
	} else if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("ListPartyFunding blank party group code = %v, want InvalidArgument", connect.CodeOf(err))
	}

	store.EXPECT().ListPartyFunding("The Greens", "", int32(25)).
		Return(&shortsstore.PartyFundingDetailRow{PartyGroup: "The Greens"}, nil)
	resp, err := server.ListPartyFunding(t.Context(), connect.NewRequest(
		&shortsv1alpha1.ListPartyFundingRequest{PartyGroup: " The Greens "}))
	if err != nil {
		t.Fatalf("ListPartyFunding: %v", err)
	}
	if resp.Msg.GetPartyGroup() != "The Greens" {
		t.Errorf("party group = %q, want the verbatim 'The Greens'", resp.Msg.GetPartyGroup())
	}
}

// A missing slug is a 404, not a 500 or an empty page — the same distinction
// GetPolitician draws, so a retired slug behaves identically on every surface.
func TestGetPoliticianFundingSlugHandling(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	server := newTestServer(t, store)

	if _, err := server.GetPoliticianFunding(t.Context(), connect.NewRequest(
		&shortsv1alpha1.GetPoliticianFundingRequest{Slug: "  "})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("blank slug code = %v, want InvalidArgument", connect.CodeOf(err))
	}

	store.EXPECT().GetPoliticianFunding("nobody-here").Return(nil, pgx.ErrNoRows)
	if _, err := server.GetPoliticianFunding(t.Context(), connect.NewRequest(
		&shortsv1alpha1.GetPoliticianFundingRequest{Slug: "Nobody-Here"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("unknown slug code = %v, want NotFound", connect.CodeOf(err))
	}
}

// The mappers carry every figure through unchanged and derive nothing. A
// receipt-type split that does not sum to the total would let a surface render
// "of which donations" against a number it does not belong to.
func TestTopDonorMapperPreservesAmountsAndSplit(t *testing.T) {
	row := &shortsstore.TopDonorRow{
		DonorName:          "Sino Iron Pty Ltd & Korean Steel Pty Ltd",
		DonorNameNorm:      "SINO IRON PTY LTD KOREAN STEEL",
		TotalCents:         26214439100,
		ReceiptCount:       7,
		DonationCents:      1000000,
		OtherReceiptCents:  26213439100,
		SubscriptionCents:  0,
		PublicFundingCents: 0,
		UnspecifiedCents:   0,
		Recipients: []*shortsstore.DonorRecipientRow{
			{PartyGroup: "Liberal", AmountCents: 26214439100},
		},
		StockCode:   "",
		CompanyName: "",
		MatchMethod: "",
	}
	got := topDonorProto(row)
	if got.GetDonorName() != row.DonorName || got.GetDonorNameNorm() != row.DonorNameNorm {
		t.Errorf("donor name/norm = (%q, %q), want the verbatim and the grouping key",
			got.GetDonorName(), got.GetDonorNameNorm())
	}
	if got.GetTotalCents() != row.TotalCents {
		t.Errorf("total = %d, want %d", got.GetTotalCents(), row.TotalCents)
	}
	split := got.GetReceiptTypes()
	sum := split.GetDonationCents() + split.GetOtherReceiptCents() + split.GetSubscriptionCents() +
		split.GetPublicFundingCents() + split.GetUnspecifiedCents()
	if sum != got.GetTotalCents() {
		t.Errorf("receipt-type split sums to %d, want the total %d", sum, got.GetTotalCents())
	}
	// An unmatched payer carries NO stock code. "Not matched" is not "not
	// listed", and the empty string is the only honest representation.
	if got.GetStockCode() != "" || got.GetMatchMethod() != "" {
		t.Errorf("unmatched payer carries stock_code=%q match=%q, want both empty",
			got.GetStockCode(), got.GetMatchMethod())
	}
	if len(got.GetRecipients()) != 1 || got.GetRecipients()[0].GetAmountCents() != row.TotalCents {
		t.Error("recipient split must carry through unchanged")
	}
}

// A nil return is a FACT — "lodged a return declaring no gifts" — and must
// survive the mapper as one, alongside the event coverage that keeps an empty
// donations list from reading as a claim.
func TestCandidateReturnMapperKeepsNilReturnsAndCoverage(t *testing.T) {
	got := candidateReturnProto(&shortsstore.CandidateElectionReturnRow{
		Event:                    "2025 Federal Election",
		EventYear:                2025,
		ReturnType:               "Candidate",
		CandidateName:            "EXAMPLE, Alice",
		ElectorateName:           "Kooyong",
		NilReturn:                true,
		AmendmentNo:              2,
		EventReturnCount:         2262,
		EventItemisedReturnCount: 69,
	})
	if !got.GetNilReturn() {
		t.Error("nil_return must survive the mapper: a lodged nil return is a publishable fact")
	}
	if got.GetEventReturnCount() != 2262 || got.GetEventItemisedReturnCount() != 69 {
		t.Errorf("event coverage = (%d, %d), want it carried on the row it caveats",
			got.GetEventReturnCount(), got.GetEventItemisedReturnCount())
	}
	if got.GetAmendmentNo() != 2 {
		t.Error("amendment_no must survive: it is why a figure moved")
	}
	if len(got.GetDonations()) != 0 {
		t.Error("no donations were supplied; the mapper must not invent any")
	}
}

// The party-funding mapper must carry post_reform_scheme through per row: the
// chart it feeds has to break at 1 Jan 2027 from the DATA, not from a constant
// in a component that will outlive whoever remembered why it is there.
func TestPartyFundingMapperCarriesTheRegimeFlags(t *testing.T) {
	got := partyFundingProto(&shortsstore.PartyFundingRow{
		PartyGroup: "Liberal", FinancialYear: "2024-25", FinancialYearEnd: 2025,
		TotalReceiptsCents: 20544268400, DeclaredDonationsCents: 3066723200,
		DistinctDonorCount: 340, ListedDonorCount: 26, ListedDonorCents: 132875700,
		ThresholdCensored: true, PostReformScheme: false,
	})
	if !got.GetThresholdCensored() {
		t.Error("threshold_censored must carry through: every old-scheme total is right-censored")
	}
	if got.GetPostReformScheme() {
		t.Error("post_reform_scheme must carry through unchanged")
	}
	if got.GetTotalReceiptsCents() != 20544268400 || got.GetDeclaredDonationsCents() != 3066723200 {
		t.Error("amounts must pass through the mapper unchanged")
	}
}

// containsFold is a case-insensitive substring check for the vocabulary sweeps.
func containsFold(haystack, needle string) bool {
	return strings.Contains(strings.ToLower(haystack), strings.ToLower(needle))
}
