package shorts

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fundStore serves the fund reads from fixed files and holdings. The holdings
// are returned as the store returns them: the shares on issue only when asked.
type fundStore struct {
	*fakeOwnershipStore
	files    []shortsstore.FundFileRow
	holdings map[int64][]shortsstore.FundHoldingDetail
	compare  map[[2]int64][]shortsstore.FundCompareRow
}

func (f *fundStore) FundFiles(context.Context) ([]shortsstore.FundFileRow, error) {
	f.read("FundFiles")
	return f.files, nil
}

func (f *fundStore) FundHoldingsOf(_ context.Context, ids []int64, withShares bool) ([]shortsstore.FundHoldingDetail, error) {
	f.read("FundHoldingsOf")
	var out []shortsstore.FundHoldingDetail
	for _, id := range ids {
		for _, h := range f.holdings[id] {
			if !withShares {
				h.SharesIssued, h.SharesAsAt = nil, ""
			}
			out = append(out, h)
		}
	}
	return out, nil
}

func (f *fundStore) FundCompareRows(_ context.Context, from, to int64) ([]shortsstore.FundCompareRow, error) {
	f.read("FundCompareRows")
	return f.compare[[2]int64{from, to}], nil
}

// fundFixtureStore is two funds: Vanguard's VAS (an ETF with a registry row, two
// files) and a super fund option with no registry row (one file).
func fundFixtureStore() *fundStore {
	d := ownershipFixture()
	for i := range d.funds {
		if d.funds[i].FundKey == "asx:VAS" {
			d.funds[i].ASXCode = "VAS"
		}
	}
	return &fundStore{
		fakeOwnershipStore: newFakeOwnershipStore(d),
		files: []shortsstore.FundFileRow{
			{ID: 1, InstitutionSlug: "vanguard", InstitutionName: "Vanguard", FundName: "Vanguard Australian Shares", FundCode: "VAS", SourceKind: "etf", SourceURL: "https://example.test/vas-0930", AsAt: "2026-09-30"},
			{ID: 2, InstitutionSlug: "vanguard", InstitutionName: "Vanguard", FundName: "Vanguard Australian Shares", FundCode: "VAS", SourceKind: "etf", SourceURL: "https://example.test/vas-1015", AsAt: "2026-10-15"},
			{ID: 3, InstitutionSlug: "hostplus", InstitutionName: "Hostplus", FundName: "Balanced", SourceKind: "super_phd", SourceURL: "https://example.test/hp", AsAt: "2026-06-30"},
		},
		holdings: map[int64][]shortsstore.FundHoldingDetail{
			1: {
				{SnapshotID: 1, StockCode: "BHP", SecurityName: "BHP Group", Industry: "Materials", Weight: new(9.0), Units: new(100.0), Value: new(3000.0), SharesIssued: new(1000.0), SharesAsAt: "2026-09-29"},
				{SnapshotID: 1, StockCode: "ZZZ", SecurityName: "Unlisted", Industry: "", Weight: new(1.0)},
			},
			2: {
				{SnapshotID: 2, StockCode: "BHP", SecurityName: "BHP Group", Industry: "Materials", Weight: new(9.5), Units: new(120.0), Value: new(3600.0), SharesIssued: new(1000.0), SharesAsAt: "2026-10-14"},
				{SnapshotID: 2, StockCode: "CBA", SecurityName: "Commonwealth Bank", Industry: "Banks", Weight: new(10.2), Units: new(50.0), Value: new(5000.0)},
				{SnapshotID: 2, StockCode: "ZZZ", SecurityName: "Unlisted", Industry: "", Weight: nil},
			},
			3: {
				{SnapshotID: 3, StockCode: "BHP", SecurityName: "BHP Group", Industry: "Materials", Weight: new(2.0)},
			},
		},
		compare: map[[2]int64][]shortsstore.FundCompareRow{
			{1, 2}: {
				{StockCode: "BHP", SecurityName: "BHP Group", Industry: "Materials", InFrom: true, InTo: true,
					FromWeight: new(9.0), ToWeight: new(9.5), FromValue: new(3000.0), ToValue: new(3600.0)},
				{StockCode: "CBA", SecurityName: "Commonwealth Bank", Industry: "Banks", InTo: true,
					ToWeight: new(10.2), ToValue: new(5000.0)},
				{StockCode: "RIO", SecurityName: "Rio Tinto", Industry: "Materials", InFrom: true,
					FromWeight: new(4.0), FromValue: new(900.0)},
				{StockCode: "ZZZ", SecurityName: "Unlisted", InFrom: true, InTo: true, FromWeight: new(1.0), ToWeight: new(1.0)},
			},
		},
	}
}

func fundServer(store *fundStore) *ShortsServer {
	clock := &fakeClock{t: ownershipTestNow}
	s := newOwnershipTestServer(store.fakeOwnershipStore, clock)
	s.ownershipStore = store
	return s
}

// deskFundFixture is the clamps fixture's fund section.
type fundFixture struct {
	FundKey struct {
		Valid   []string `json:"valid"`
		Invalid []string `json:"invalid"`
	} `json:"fundKey"`
	Normalised []struct {
		In  string `json:"in"`
		Out string `json:"out"`
	} `json:"normalised"`
	ActivityKind []struct {
		In       string `json:"in"`
		Out      string `json:"out"`
		Rejected bool   `json:"rejected"`
	} `json:"activityKind"`
	SnapshotDate struct {
		Valid   []string `json:"valid"`
		Invalid []string `json:"invalid"`
	} `json:"snapshotDate"`
}

func TestFundClampsFixtureMatchesTheHandlers(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "web", "src", "@", "lib", "ownership", "__fixtures__", "clamps.json"))
	require.NoError(t, err)
	var doc struct {
		Fund fundFixture `json:"fund"`
	}
	require.NoError(t, json.Unmarshal(raw, &doc))
	fx := doc.Fund

	for _, k := range fx.FundKey.Valid {
		_, err := parseFundKey(k)
		assert.NoError(t, err, "valid fund key %q", k)
	}
	for _, k := range fx.FundKey.Invalid {
		_, err := parseFundKey(k)
		assert.Error(t, err, "invalid fund key %q", k)
	}
	for _, n := range fx.Normalised {
		got, err := parseFundKey(n.In)
		require.NoError(t, err, n.In)
		assert.Equal(t, n.Out, got)
	}
	for _, d := range fx.SnapshotDate.Valid {
		_, _, err := deskDate("as_at", d)
		assert.NoError(t, err, d)
	}
	for _, d := range fx.SnapshotDate.Invalid {
		_, _, err := deskDate("as_at", d)
		assert.Error(t, err, d)
	}
	for _, c := range fx.ActivityKind {
		got, err := deskActivityKind(c.In)
		if c.Rejected {
			assert.Error(t, err, c.In)
			continue
		}
		require.NoError(t, err, c.In)
		assert.Equal(t, c.Out, got)
	}
}

func TestFundKeyIsRefusedByShapeNotGuessed(t *testing.T) {
	_, err := parseFundKey("A200")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "fund_key must be a registry key")
	// The registry prefix is closed: an unknown prefix is not a slug either.
	_, err = parseFundKey("isin:AU000000VAS3")
	assert.Error(t, err)
}

func TestBuildFundBookKeysEachFundOnceAndMatchesTheRegistry(t *testing.T) {
	store := fundFixtureStore()
	registry := []shortsstore.OwnershipFundRow{
		{FundKey: "asx:VAS", InstitutionSlug: "vanguard", ASXCode: "VAS", Size: new(2.1e10)},
		{FundKey: "abn:1", InstitutionSlug: "hostplus", Size: new(1.2e11)},
	}
	book := buildFundBook(store.files, registry)
	require.Len(t, book.funds, 2)
	// The registry row matches the ETF by institution and ASX code.
	vas := book.byKey["asx:VAS"]
	require.NotNil(t, vas)
	assert.Equal(t, "vanguard/Vanguard Australian Shares", vas.slug+"/"+vas.name)
	assert.Len(t, vas.files, 2)
	// The super fund option has no ASX code to match, so it is keyed by its name.
	assert.NotNil(t, book.byKey["hostplus/Balanced"])
	assert.Nil(t, book.byKey["hostplus/Balanced"].registry)
	// The larger registry size is listed first.
	assert.Equal(t, "asx:VAS", book.funds[0].key)
}

func TestBuildFundBookLetsARegistryRowMatchOneFundOnly(t *testing.T) {
	files := []shortsstore.FundFileRow{
		{ID: 1, InstitutionSlug: "vanguard", FundName: "A", FundCode: "VAS", AsAt: "2026-09-30"},
		{ID: 2, InstitutionSlug: "vanguard", FundName: "B", FundCode: "VAS", AsAt: "2026-09-30"},
	}
	registry := []shortsstore.OwnershipFundRow{{FundKey: "asx:VAS", InstitutionSlug: "vanguard", ASXCode: "VAS"}}
	book := buildFundBook(files, registry)
	require.Len(t, book.funds, 2)
	assert.NotNil(t, book.byKey["asx:VAS"], "the first fund takes the registry key")
	assert.NotNil(t, book.byKey["vanguard/B"], "the second keeps its name")
}

func TestFundSectorsGroupPlaceholdersAsOtherAndLeaveUnknownWeightsLast(t *testing.T) {
	rows := []shortsstore.FundHoldingDetail{
		{StockCode: "BHP", Industry: "Materials", Weight: new(9.0)},
		{StockCode: "RIO", Industry: "Materials", Weight: new(4.0)},
		{StockCode: "CBA", Industry: "Banks", Weight: new(10.2)},
		{StockCode: "XXX", Industry: "Not Applic", Weight: new(1.0)},
		{StockCode: "YYY", Industry: "", Weight: new(0.5)},
		{StockCode: "ZZZ", Industry: "Telecom", Weight: nil},
	}
	got := fundSectorWeights(rows)
	require.Len(t, got, 4)
	assert.Equal(t, "Materials", got[0].Industry, "the largest sector first")
	assert.InDelta(t, 13.0, got[0].WeightPct, 1e-9)
	assert.Equal(t, "Banks", got[1].Industry)
	assert.InDelta(t, 10.2, got[1].WeightPct, 1e-9)
	assert.Equal(t, "Other", got[2].Industry)
	assert.InDelta(t, 1.5, got[2].WeightPct, 1e-9)
	assert.Equal(t, "Telecom", got[3].Industry)
	assert.False(t, got[3].HasWeightPct, "a sector with no stated weight is n/a, never 0")
}

func TestFundTopTenAndCompanyShareNeedBothFigures(t *testing.T) {
	var rows []shortsstore.FundHoldingDetail
	for i := range 12 {
		rows = append(rows, shortsstore.FundHoldingDetail{StockCode: string(rune('A'+i)) + "X", Weight: new(float64(12 - i))})
	}
	rows = append(rows, shortsstore.FundHoldingDetail{StockCode: "NIL"})
	top, ok := fundTopPct(rows, fundTopN)
	require.True(t, ok)
	assert.InDelta(t, 12+11+10+9+8+7+6+5+4+3, top, 1e-9, "the ten largest, unknown weights last")
	_, ok = fundTopPct([]shortsstore.FundHoldingDetail{{StockCode: "NIL"}}, fundTopN)
	assert.False(t, ok)
	// One of the top ten without a weight withholds the sum: it is not the top n.
	partial := []shortsstore.FundHoldingDetail{{StockCode: "AAA", Weight: new(5.0)}, {StockCode: "BBB"}}
	_, ok = fundTopPct(partial, fundTopN)
	assert.False(t, ok, "a partial top ten is withheld, never reported as the top ten")
	_, ok = fundTopPct(nil, fundTopN)
	assert.False(t, ok)

	pct, ok := estCompanyPct(new(250.0), new(1000.0))
	require.True(t, ok)
	assert.InDelta(t, 25.0, pct, 1e-9)
	_, ok = estCompanyPct(new(250.0), nil)
	assert.False(t, ok, "no shares on issue is n/a")
	_, ok = estCompanyPct(new(250.0), new(0.0))
	assert.False(t, ok, "zero shares on issue is n/a")
}

func TestListFundsSummarisesEachFundsNewestFile(t *testing.T) {
	store := fundFixtureStore()
	s := fundServer(store)
	resp, err := s.ListFunds(context.Background(), connect.NewRequest(&shortsv1alpha1.ListFundsRequest{}))
	require.NoError(t, err)
	require.Len(t, resp.Msg.Funds, 2)
	vas := resp.Msg.Funds[0]
	assert.Equal(t, "asx:VAS", vas.FundKey)
	assert.Equal(t, "VAS", vas.Ticker)
	assert.Equal(t, "2026-10-15", vas.AsAt, "the newest file")
	assert.True(t, vas.Pooled, "Vanguard's ETF files are the pooled fund")
	assert.EqualValues(t, 3, vas.Holdings)
	assert.True(t, vas.HasAumAud)
	require.NotEmpty(t, vas.Largest)
	assert.Equal(t, "CBA", vas.Largest[0].Code)
	assert.False(t, vas.HasTop10Pct, "ZZZ states no weight and is in the top ten of a three-line file")
	assert.Equal(t, "Other", vas.SectorWeights[len(vas.SectorWeights)-1].Industry, "the unclassified holding is Other")

	super := resp.Msg.Funds[1]
	assert.Equal(t, "hostplus/Balanced", super.FundKey)
	assert.False(t, super.Pooled)
	assert.False(t, super.HasAumAud)
}

func TestBuildFundBookResolvesTheRegistryKeyAndTheNameKey(t *testing.T) {
	files := []shortsstore.FundFileRow{
		{ID: 1, InstitutionSlug: "state-street", InstitutionName: "State Street", FundName: "SPDR S&P/ASX 200 Fund", FundCode: "STW", SourceKind: "etf", AsAt: "2026-10-15"},
	}
	// The registry row's code was never filled in: it is matched by its key.
	registry := []shortsstore.OwnershipFundRow{{FundKey: "asx:STW", InstitutionSlug: "state-street", Name: "SPDR S&P/ASX 200 Fund"}}
	book := buildFundBook(files, registry)
	require.Len(t, book.funds, 1)
	fund := book.byKey["asx:STW"]
	require.NotNil(t, fund, "the registry key resolves")
	require.NotNil(t, fund.registry)
	assert.Same(t, fund, book.byKey["state-street/SPDR S&P/ASX 200 Fund"], "the name key, from before the registry row, resolves too")

	k, err := parseFundKey("state-street/SPDR S&P/ASX 200 Fund")
	require.NoError(t, err)
	assert.Same(t, fund, book.byKey[k])
}

func TestListFundsIsCachedBesideTheUniverse(t *testing.T) {
	store := fundFixtureStore()
	s := fundServer(store)
	ctx := context.Background()
	_, err := s.ListFunds(ctx, connect.NewRequest(&shortsv1alpha1.ListFundsRequest{}))
	require.NoError(t, err)
	reads := store.reads["FundHoldingsOf"]
	_, err = s.ListFunds(ctx, connect.NewRequest(&shortsv1alpha1.ListFundsRequest{}))
	require.NoError(t, err)
	assert.Equal(t, reads, store.reads["FundHoldingsOf"], "the second call is served from the cache")
}

func TestGetFundPortfolioReadsTheFileAsAtAndWithholdsAShareWithoutShares(t *testing.T) {
	store := fundFixtureStore()
	s := fundServer(store)
	ctx := context.Background()

	newest, err := s.GetFundPortfolio(ctx, connect.NewRequest(&shortsv1alpha1.GetFundPortfolioRequest{FundKey: "asx:VAS"}))
	require.NoError(t, err)
	assert.Equal(t, "2026-10-15", newest.Msg.AsAt)
	assert.Equal(t, []string{"2026-09-30", "2026-10-15"}, newest.Msg.SnapshotDates)
	require.Len(t, newest.Msg.Holdings, 3, "by weight: CBA, BHP, then the unknown weight")
	bhp := newest.Msg.Holdings[1]
	assert.Equal(t, "BHP", bhp.Code)
	assert.True(t, bhp.HasEstCompanyPct)
	assert.InDelta(t, 12.0, bhp.EstCompanyPct, 1e-9, "120 units over 1000 shares")
	assert.True(t, bhp.HasSharesOnIssue)
	assert.Equal(t, "2026-10-14", bhp.SharesOnIssueAsAt, "the ASIC report behind the shares, not the file date")
	cba := newest.Msg.Holdings[0]
	assert.False(t, cba.HasSharesOnIssue, "no shares on issue reported is n/a")
	assert.Empty(t, cba.SharesOnIssueAsAt)
	assert.False(t, cba.HasEstCompanyPct)
	zzz := newest.Msg.Holdings[2]
	assert.False(t, zzz.HasWeightPct, "an unknown weight is n/a")
	assert.Equal(t, "Other", zzz.Industry)

	// An as_at between two files reads the older one; before the first, nothing.
	earlier, err := s.GetFundPortfolio(ctx, connect.NewRequest(&shortsv1alpha1.GetFundPortfolioRequest{FundKey: "asx:VAS", AsAt: "2026-10-01"}))
	require.NoError(t, err)
	assert.Equal(t, "2026-09-30", earlier.Msg.AsAt)
	none, err := s.GetFundPortfolio(ctx, connect.NewRequest(&shortsv1alpha1.GetFundPortfolioRequest{FundKey: "asx:VAS", AsAt: "2020-01-01"}))
	require.NoError(t, err)
	assert.Empty(t, none.Msg.AsAt)
	assert.Empty(t, none.Msg.Holdings)

	_, err = s.GetFundPortfolio(ctx, connect.NewRequest(&shortsv1alpha1.GetFundPortfolioRequest{FundKey: "asx:ZZZ"}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
	_, err = s.GetFundPortfolio(ctx, connect.NewRequest(&shortsv1alpha1.GetFundPortfolioRequest{FundKey: "A200"}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	_, err = s.GetFundPortfolio(ctx, connect.NewRequest(&shortsv1alpha1.GetFundPortfolioRequest{FundKey: "asx:VAS", AsAt: "2026-02-30"}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

func TestCompareFundSnapshotsOfOneFileHasNoRows(t *testing.T) {
	store := fundFixtureStore()
	s := fundServer(store)
	ctx := context.Background()

	// Hostplus has one file: an empty request resolves both sides to it.
	one, err := s.CompareFundSnapshots(ctx, connect.NewRequest(&shortsv1alpha1.CompareFundSnapshotsRequest{FundKey: "hostplus/Balanced"}))
	require.NoError(t, err)
	assert.Equal(t, "2026-06-30", one.Msg.From)
	assert.Equal(t, "2026-06-30", one.Msg.To)
	assert.Empty(t, one.Msg.Rows, "a file compared with itself is not a change")
	assert.Equal(t, []string{"2026-06-30"}, one.Msg.SnapshotDates)
	assert.Zero(t, store.reads["FundCompareRows"], "no comparison is read")

	// Two dates that resolve to the same VAS file: 1 October reads the 30 September file.
	same, err := s.CompareFundSnapshots(ctx, connect.NewRequest(&shortsv1alpha1.CompareFundSnapshotsRequest{FundKey: "asx:VAS", From: "2026-09-30", To: "2026-10-01"}))
	require.NoError(t, err)
	assert.Equal(t, "2026-09-30", same.Msg.From)
	assert.Equal(t, "2026-09-30", same.Msg.To)
	assert.Empty(t, same.Msg.Rows)
}

func TestCompareFundSnapshotsStatusesAndOrder(t *testing.T) {
	store := fundFixtureStore()
	s := fundServer(store)
	ctx := context.Background()

	resp, err := s.CompareFundSnapshots(ctx, connect.NewRequest(&shortsv1alpha1.CompareFundSnapshotsRequest{FundKey: "asx:VAS"}))
	require.NoError(t, err)
	assert.Equal(t, "2026-09-30", resp.Msg.From, "an empty from is the file before to")
	assert.Equal(t, "2026-10-15", resp.Msg.To)
	assert.Equal(t, "https://example.test/vas-0930", resp.Msg.SourceFrom)
	rows := resp.Msg.Rows
	require.Len(t, rows, 4)
	// Continuing holdings first, by |delta|: BHP (+0.5) and ZZZ (0, no change) last.
	assert.Equal(t, "BHP", rows[0].Code)
	assert.Equal(t, "continuing", rows[0].Status)
	assert.InDelta(t, 0.5, rows[0].DeltaPp, 1e-9)
	assert.Equal(t, "ZZZ", rows[1].Code)
	// New on the later file, then dropped from the earlier one.
	assert.Equal(t, "CBA", rows[2].Code)
	assert.Equal(t, "new", rows[2].Status)
	assert.False(t, rows[2].HasDeltaPp)
	assert.Equal(t, "RIO", rows[3].Code)
	assert.Equal(t, "dropped", rows[3].Status)
	assert.False(t, rows[3].HasWeightToPct)

	// A from after an explicit to is refused; a from after the newest file, with
	// no to, is refused by name.
	_, err = s.CompareFundSnapshots(ctx, connect.NewRequest(&shortsv1alpha1.CompareFundSnapshotsRequest{FundKey: "asx:VAS", From: "2026-10-15", To: "2026-09-30"}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	_, err = s.CompareFundSnapshots(ctx, connect.NewRequest(&shortsv1alpha1.CompareFundSnapshotsRequest{FundKey: "asx:VAS", From: "2026-11-01"}))
	require.Error(t, err)
	assert.ErrorContains(t, err, "from must not be after the newest snapshot, 2026-10-15")
}

func TestActivityKindIsAHolderKindOrEverything(t *testing.T) {
	got, err := deskActivityKind("")
	require.NoError(t, err)
	assert.Empty(t, got)
	got, err = deskActivityKind(" Super_Fund ")
	require.NoError(t, err)
	assert.Equal(t, "super_fund", got)
	_, err = deskActivityKind("bogus")
	assert.ErrorContains(t, err, "is not a holder kind")
}

func TestFundRpcsAnswerEmptyWithoutAFundStore(t *testing.T) {
	clock := &fakeClock{t: ownershipTestNow}
	s := newOwnershipTestServer(newFakeOwnershipStore(ownershipFixture()), clock)
	list, err := s.ListFunds(context.Background(), connect.NewRequest(&shortsv1alpha1.ListFundsRequest{}))
	require.NoError(t, err)
	assert.Empty(t, list.Msg.Funds)
	p, err := s.GetFundPortfolio(context.Background(), connect.NewRequest(&shortsv1alpha1.GetFundPortfolioRequest{FundKey: "asx:VAS"}))
	require.NoError(t, err)
	assert.Empty(t, p.Msg.Holdings)
}
