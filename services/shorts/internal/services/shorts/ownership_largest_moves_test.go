package shorts

import (
	"context"
	"fmt"
	"testing"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// moveNotice is a 604 stating both figures.
func moveNotice(code, slug, kind string, present, previous float64, announced, url string) shortsstore.SubstantialNoticeRow {
	return shortsstore.SubstantialNoticeRow{
		StockCode: code, HolderKey: slug, HolderName: slug, InstitutionSlug: slug, Kind: kind, Form: "604",
		PresentPct: new(present), PreviousPct: new(previous), AnnouncedOn: announced, AnnouncementURL: url,
	}
}

func TestLargestMovesRankBySizeThenDateThenCode(t *testing.T) {
	u := ownershipFixtureUniverse()
	rows := []shortsstore.SubstantialNoticeRow{
		moveNotice("BHP", "citigroup", "bank_broker", 6.3, 5.0, "2026-10-02", "u-bhp"),
		{StockCode: "PLS", HolderKey: "regal-partners", HolderName: "Regal Partners", Kind: "hedge_fund", Form: "604",
			PresentPct: new(3.3), PreviousPct: new(2.0), AnnouncedOn: "2026-10-05", AnnouncementURL: "u-pls"},
		moveNotice("ANZ", "x-bank", "bank_broker", 4.0, 2.7, "2026-10-02", "u-anz"),
		moveNotice("WBC", "big", "hedge_fund", 9.0, 1.0, "2026-09-01", "u-wbc"),
		moveNotice("CBA", "vanguard", "index_manager", 4.0, 4.5, "2026-06-01", "u-cba"),
		// Not ranked: one figure stated, a cessation, a Form 605, no change.
		{StockCode: "NAB", HolderKey: "a", Form: "603", PresentPct: new(6.0), AnnouncedOn: "2026-10-03", AnnouncementURL: "u-nab"},
		{StockCode: "RIO", HolderKey: "b", Form: "605", Ceased: true, PreviousPct: new(4.0), AnnouncedOn: "2026-10-05", AnnouncementURL: "u-rio"},
		{StockCode: "XYZ", HolderKey: "c", Form: "605", PresentPct: new(1.0), PreviousPct: new(9.0), AnnouncedOn: "2026-10-05", AnnouncementURL: "u-xyz"},
		moveNotice("TLS", "d", "hedge_fund", 2.0, 2.0, "2026-10-05", "u-tls"),
		{StockCode: "QAN", HolderKey: "e", Form: "604", PreviousPct: new(3.0), AnnouncedOn: "2026-10-05", AnnouncementURL: "u-qan"},
	}
	got := buildLargestMoves(u, rows, activityMaxMoves)
	require.Len(t, got, 5, "only the five notices that state a change")
	var codes []string
	for _, m := range got {
		codes = append(codes, m.StockCode)
	}
	// WBC is the largest (8 points). PLS, ANZ and BHP are 1.3 points each: the newer
	// release first (PLS), then the same date by code (ANZ before BHP). CBA's 0.5 last.
	assert.Equal(t, []string{"WBC", "PLS", "ANZ", "BHP", "CBA"}, codes)

	wbc := got[0]
	assert.InDelta(t, 8, wbc.ChangePp, 1e-9)
	assert.Equal(t, "increased", wbc.Event)
	assert.InDelta(t, 9, wbc.PresentPct, 1e-9)
	assert.InDelta(t, 1, wbc.PreviousPct, 1e-9)
	assert.Equal(t, "2026-09-01", wbc.AnnouncedOn)
	assert.Equal(t, "u-wbc", wbc.AnnouncementUrl)

	cba := got[4]
	assert.InDelta(t, -0.5, cba.ChangePp, 1e-9)
	assert.Equal(t, "decreased", cba.Event)
	assert.Equal(t, "vanguard", cba.HolderSlug)
	assert.True(t, cba.HasInstitution)

	pls := got[1]
	assert.Equal(t, "regal-partners", pls.HolderSlug)
	assert.False(t, pls.HasInstitution, "a holder with no institution page carries its key")
}

func TestLargestMovesAreCapped(t *testing.T) {
	u := ownershipFixtureUniverse()
	var rows []shortsstore.SubstantialNoticeRow
	for i := range 12 {
		rows = append(rows, moveNotice(fmt.Sprintf("S%02d", i), "fund", "hedge_fund", float64(i+2), 1, "2026-10-05", fmt.Sprintf("u%02d", i)))
	}
	got := buildLargestMoves(u, rows, activityMaxMoves)
	require.Len(t, got, activityMaxMoves, "at most ten")
	assert.Equal(t, "S11", got[0].StockCode, "the largest first")
	assert.Equal(t, "S02", got[9].StockCode, "the two smallest left out")
	assert.Len(t, buildLargestMoves(u, rows, 3), 3, "a smaller limit keeps fewer")
	assert.Empty(t, buildLargestMoves(u, nil, activityMaxMoves))
}

// The activity read serves the window's largest moves for the request's kind.
func TestGetOwnershipActivityServesTheLargestMoves(t *testing.T) {
	store := deskTestStore(deskNotices())
	s, _ := deskServer(store)
	ctx := context.Background()

	resp, err := s.GetOwnershipActivity(ctx, connect.NewRequest(&shortsv1alpha1.GetOwnershipActivityRequest{}))
	require.NoError(t, err)
	require.Len(t, resp.Msg.LargestMoves, 2, "the citigroup rise and the vanguard fall; the 603 and the 605 are not ranked")
	first := resp.Msg.LargestMoves[0]
	assert.Equal(t, "citigroup", first.HolderSlug)
	assert.InDelta(t, 1.3, first.ChangePp, 1e-9)
	assert.Equal(t, "increased", first.Event)
	assert.Equal(t, "BHP", first.StockCode)
	assert.InDelta(t, -0.5, resp.Msg.LargestMoves[1].ChangePp, 1e-9)

	resp, err = s.GetOwnershipActivity(ctx, connect.NewRequest(&shortsv1alpha1.GetOwnershipActivityRequest{Kind: "index_manager"}))
	require.NoError(t, err)
	require.Len(t, resp.Msg.LargestMoves, 1)
	assert.Equal(t, "vanguard", resp.Msg.LargestMoves[0].HolderSlug)
}
