//go:build integration

package shorts

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Runs against an EXISTING database that carries the council foundation data
// (000126 + `house-price-collector -mode lga`, erp-lga, ...). Read-only: it
// never creates, writes or refreshes anything, so it is safe on the shared
// local DB. Skips when the database or the council data is absent.
//
//	cd services && GOWORK=off go test -tags integration -run TestCouncilHub ./shorts/internal/store/shorts/ -v
func openCouncilHubDB(t *testing.T) *postgresStore {
	t.Helper()
	dsn := os.Getenv("SHORTS_TEST_DATABASE_URL")
	if dsn == "" {
		dsn = "postgresql://admin:password@localhost:5438/shorts"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Skipf("council hub database unavailable: %v", err)
	}
	t.Cleanup(pool.Close)
	var councils int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM lga WHERE kind = 'council' AND slug IS NOT NULL`).Scan(&councils); err != nil || councils == 0 {
		t.Skipf("council foundation data not loaded (%d councils, %v)", councils, err)
	}
	return &postgresStore{db: pool}
}

func TestCouncilHubListCouncils(t *testing.T) {
	store := openCouncilHubDB(t)
	for _, st := range []string{"NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"} {
		start := time.Now()
		rows, err := store.ListCouncils(st)
		if err != nil {
			t.Fatalf("ListCouncils(%s): %v", st, err)
		}
		t.Logf("ListCouncils(%s): %d councils in %s", st, len(rows), time.Since(start).Round(time.Millisecond))
		if len(rows) == 0 {
			t.Errorf("ListCouncils(%s) is empty", st)
		}
		for _, r := range rows {
			if r.Kind != "council" && r.Kind != "unincorporated" {
				t.Errorf("%s: kind %q has no page", r.DisplayName, r.Kind)
			}
			if r.Slug == "" {
				t.Errorf("%s: no slug", r.DisplayName)
			}
			// No source covers flood planning outside NSW/VIC: absent, not 0.
			if (st == "QLD" || st == "WA") && r.FloodSharePct != nil {
				t.Errorf("%s (%s): flood share %v where no source covers it", r.DisplayName, st, *r.FloodSharePct)
			}
		}
	}
}

func TestCouncilHubProfiles(t *testing.T) {
	store := openCouncilHubDB(t)
	cases := []struct{ state, slug string }{
		{"QLD", "brisbane"}, {"NSW", "canterbury-bankstown"}, {"VIC", "yarra"},
		{"NSW", "broken-hill"}, {"ACT", "unincorporated-act"},
	}
	for _, c := range cases {
		start := time.Now()
		p, err := store.GetCouncilProfile(c.state, c.slug)
		if err != nil {
			t.Fatalf("GetCouncilProfile(%s/%s): %v", c.state, c.slug, err)
		}
		elapsed := time.Since(start).Round(time.Millisecond)
		if p.Summary == nil {
			t.Fatalf("%s: no summary row", c.slug)
		}
		t.Logf("%s/%s: %s kind=%s pop=%d suburbs=%d (dominant %d) series=%d neighbours=%d fed=%d state=%d drops=%v in %s",
			c.state, c.slug, p.Facts.DisplayName, p.Facts.Kind, p.Summary.Population, len(p.Suburbs),
			p.Rollup.DominantSuburbs, len(p.Series), len(p.Neighbours), len(p.FederalSeats), len(p.StateSeats),
			p.PriceDrops != nil, elapsed)
		if len(p.Suburbs) == 0 {
			t.Errorf("%s: no member suburbs", c.slug)
		}
		for _, s := range p.Suburbs {
			if !s.Dominant && s.Share < councilMemberMinShare {
				t.Errorf("%s: straddler %s at %.3f is below the member floor", c.slug, s.SALName, s.Share)
			}
		}
	}
	if _, err := store.GetCouncilProfile("NSW", "no-such-council"); !errors.Is(err, ErrCouncilNotFound) {
		t.Errorf("unknown slug: want ErrCouncilNotFound, got %v", err)
	}
	// A slug exists only within its own state.
	if _, err := store.GetCouncilProfile("VIC", "brisbane"); !errors.Is(err, ErrCouncilNotFound) {
		t.Errorf("wrong state: want ErrCouncilNotFound, got %v", err)
	}
}
