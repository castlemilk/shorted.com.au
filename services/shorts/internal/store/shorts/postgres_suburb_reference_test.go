package shorts

import (
	"errors"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func readSuburbReferenceMigration(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("../../../../migrations/000139_suburb_reference_mvs.up.sql")
	if err != nil {
		t.Fatalf("read 000139: %v", err)
	}
	return string(b)
}

var sqlSpace = regexp.MustCompile(`\s+`)

// normalizeSQL collapses whitespace and drops spaces inside parentheses and
// around commas, so the same SQL indented differently compares equal.
func normalizeSQL(s string) string {
	s = sqlSpace.ReplaceAllString(strings.TrimSpace(s), " ")
	for _, r := range []struct{ from, to string }{{"( ", "("}, {" )", ")"}, {" ,", ","}, {", ", ","}} {
		s = strings.ReplaceAll(s, r.from, r.to)
	}
	return s
}

// The view mv_suburb_latest_price must pick exactly what the live LATERAL
// picks: the same latest/YoY subquery (licence gate included) and the same
// preference order after sal_code. The integration test checks the rows; this
// checks the text, so it runs without a database.
func TestSuburbLatestPriceView_IsThePreferredRegionJoin(t *testing.T) {
	migration := normalizeSQL(readSuburbReferenceMigration(t))
	live := preferredSuburbRegionJoin

	start := strings.Index(live, "SELECT latest.value, latest.period,")
	end := strings.Index(live, ") hp ON true")
	if start < 0 || end < start {
		t.Fatal("preferredSuburbRegionJoin no longer has the latest/YoY LATERAL this test compares")
	}
	lateral := normalizeSQL(live[start:end])
	if !strings.Contains(migration, lateral) {
		t.Errorf("mv_suburb_latest_price's price LATERAL differs from preferredSuburbRegionJoin's:\nlive: %s", lateral)
	}
	for _, want := range []string{
		"WHERE sr.region_type = 'suburb' AND sr.sal_code IS NOT NULL",
		"ORDER BY sr.sal_code,(hp.value IS NOT NULL) DESC,hp.period DESC NULLS LAST,sr.region_code;",
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_suburb_latest_price_sal ON mv_suburb_latest_price (sal_code);",
	} {
		if !strings.Contains(migration, normalizeSQL(want)) {
			t.Errorf("000139 missing %q", want)
		}
	}
	if !strings.Contains(normalizeSQL(live), normalizeSQL("ORDER BY (hp.value IS NOT NULL) DESC, hp.period DESC NULLS LAST, sr.region_code LIMIT 1")) {
		t.Error("preferredSuburbRegionJoin changed its preference order: change mv_suburb_latest_price to match")
	}
}

// Every aggregate the live baselines compute must be in mv_housing_state_baselines,
// character for character.
func TestStateBaselinesView_HoldsEveryLiveAggregate(t *testing.T) {
	migration := normalizeSQL(readSuburbReferenceMigration(t))
	shares := regexp.MustCompile(`(?m)^\s*SUM\(sd\..*$`).FindAllString(suburbBaselinesLiveJoin, -1)
	if len(shares) != 12 {
		t.Fatalf("expected 12 Census shares in suburbBaselinesLiveJoin, found %d", len(shares))
	}
	for _, expr := range shares {
		if !strings.Contains(migration, normalizeSQL(strings.TrimSuffix(strings.TrimSpace(expr), ","))) {
			t.Errorf("mv_housing_state_baselines lacks the live aggregate %q", strings.TrimSpace(expr))
		}
	}
	income := "percentile_cont(0.5) WITHIN GROUP (ORDER BY sd.median_weekly_hhd_income) FILTER (WHERE sd.median_weekly_hhd_income > 0) AS median_hhd_income"
	if !strings.Contains(normalizeSQL(suburbBaselinesLiveJoin), normalizeSQL(income)) {
		t.Error("suburbBaselinesLiveJoin changed the state income median: change mv_housing_state_baselines to match")
	}
	for _, want := range []string{
		income,
		// The price baseline: the latest public suburb median per region.
		"WHERE sr.region_type = 'suburb' AND hp.source_licence <> 'proprietary-tos-restricted' AND hp.measure = 'median_price' AND hp.dwelling_type = 'house' ORDER BY hp.region_code, hp.period DESC",
		"percentile_cont(0.5) WITHIN GROUP (ORDER BY value) AS state_median_price",
		"percentile_cont(0.5) WITHIN GROUP (ORDER BY median_weekly_hhd_income) AS national_median_hhd_income FROM suburb_demographics WHERE median_weekly_hhd_income > 0",
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_housing_state_baselines_state ON mv_housing_state_baselines (state_code);",
	} {
		if !strings.Contains(migration, normalizeSQL(want)) {
			t.Errorf("000139 missing %q", want)
		}
	}
}

// The similarity features are the live kNN's six features over the same
// population floor and candidate rule.
func TestSimilarityFeaturesView_UsesTheLiveFeatures(t *testing.T) {
	migration := normalizeSQL(readSuburbReferenceMigration(t))
	live := normalizeSQL(similarSuburbsLiveQuery)
	pairs := []struct{ live, view string }{
		{"COALESCE(a.amenity_density_score,0)", "COALESCE(a.amenity_density_score,0) AS den"},
		{"ln(GREATEST(d.population,1))", "ln(GREATEST(d.population,1)) AS lpop"},
		{"LEAST(COALESCE(a.dist_to_coast_km,0),100)", "LEAST(COALESCE(a.dist_to_coast_km,0),100) AS coast"},
		{"WHERE d.population > 200 )", "WHERE population > 200 )"},
		{"d.population > 200 AND d.median_age IS NOT NULL AND d.median_weekly_hhd_income IS NOT NULL",
			"(f.population > 200 AND f.median_age IS NOT NULL AND f.median_weekly_hhd_income IS NOT NULL) AS candidate"},
	}
	for _, p := range pairs {
		if !strings.Contains(live, normalizeSQL(p.live)) {
			t.Errorf("similarSuburbsLiveQuery no longer has %q: change mv_suburb_similarity_features to match", p.live)
		}
		if !strings.Contains(migration, normalizeSQL(p.view)) {
			t.Errorf("mv_suburb_similarity_features missing %q", p.view)
		}
	}
	for _, feature := range []string{"median_age / s.sage", "median_weekly_hhd_income / s.sinc", "pct_born_overseas / s.sbo", "den / s.sden", "lpop / s.spop", "coast / s.scoast"} {
		if !strings.Contains(migration, feature) {
			t.Errorf("mv_suburb_similarity_features does not divide %q by its deviation", feature)
		}
	}
	for _, stat := range []string{"stddev_pop(median_age)", "stddev_pop(median_weekly_hhd_income)", "stddev_pop(pct_born_overseas)", "stddev_pop(den)", "stddev_pop(lpop)", "stddev_pop(coast)"} {
		if !strings.Contains(migration, "NULLIF("+stat+",0)") {
			t.Errorf("a zero deviation must drop the term (NULLIF(%s, 0))", stat)
		}
	}
}

// Each source reads only itself: the view queries never fall back into the
// per-request aggregates, and the live queries never name a 000139 view.
func TestSuburbReferenceQueries_ReadOnlyTheirSource(t *testing.T) {
	views := []string{
		listStateSuburbsQuery(suburbFromViews),
		suburbProfileQuery(suburbFromViews),
		similarSuburbsQuery(suburbFromViews),
		councilSuburbsQueryFrom(suburbFromViews),
	}
	for i, q := range views {
		for _, forbid := range []string{"stddev_pop", "FROM house_prices", "percentile_cont", "LEFT JOIN LATERAL (\n\t\t\tSELECT sr.region_code"} {
			if strings.Contains(q, forbid) {
				t.Errorf("view query %d recomputes per request: contains %q", i, forbid)
			}
		}
	}
	live := []string{
		listStateSuburbsQuery(suburbFromLiveSQL),
		suburbProfileQuery(suburbFromLiveSQL),
		similarSuburbsQuery(suburbFromLiveSQL),
		councilSuburbsQueryFrom(suburbFromLiveSQL),
	}
	for i, q := range live {
		for _, mv := range []string{"mv_suburb_latest_price", "mv_housing_state_baselines", "mv_suburb_similarity_features"} {
			if strings.Contains(q, mv) {
				t.Errorf("live query %d names %s, so it cannot serve a database without 000139", i, mv)
			}
		}
	}
	if !strings.Contains(suburbProfileQuery(suburbFromViews), "mv_housing_state_baselines sb ON sb.state_code = d.state_code") {
		t.Error("the profile must read its baselines from mv_housing_state_baselines")
	}
	cols, _, err := buildSuburbMetricQuery([]string{"price"})
	if err != nil || !strings.Contains(cols, "mv_suburb_latest_price") {
		t.Errorf("the price column must read mv_suburb_latest_price (err %v):\n%s", err, cols)
	}
}

func TestReadSuburbReference_FallsBackOnlyWhenAViewIsMissing(t *testing.T) {
	suburbViewsMissingUntil.Store(0)
	t.Cleanup(func() { suburbViewsMissingUntil.Store(0) })
	undefined := &pgconn.PgError{Code: "42P01", Message: `relation "mv_suburb_latest_price" does not exist`}

	var tried []suburbReadSource
	got, err := readSuburbReference("test", func(src suburbReadSource) (string, error) {
		tried = append(tried, src)
		if src == suburbFromViews {
			return "", undefined
		}
		return "live", nil
	})
	if err != nil || got != "live" {
		t.Fatalf("missing view: got %q, %v; want the live result", got, err)
	}
	if len(tried) != 2 || tried[0] != suburbFromViews || tried[1] != suburbFromLiveSQL {
		t.Fatalf("sources tried %v: views first, live only after 42P01", tried)
	}

	// Within the recheck window the readers go straight to the live SQL: no
	// failed statement per request while 000139 is not applied.
	tried = nil
	got, err = readSuburbReference("test", func(src suburbReadSource) (string, error) {
		tried = append(tried, src)
		return "live", nil
	})
	if err != nil || got != "live" || len(tried) != 1 || tried[0] != suburbFromLiveSQL {
		t.Fatalf("inside the recheck window: got %q, %v after %v; want the live SQL only", got, err, tried)
	}

	// Once the window has passed, the views are tried again.
	suburbViewsMissingUntil.Store(time.Now().Add(-time.Second).UnixNano())
	tried = nil
	got, err = readSuburbReference("test", func(src suburbReadSource) (string, error) {
		tried = append(tried, src)
		return "views", nil
	})
	if err != nil || got != "views" || len(tried) != 1 || tried[0] != suburbFromViews {
		t.Fatalf("views present: got %q, %v after %v; want the views only", got, err, tried)
	}

	// A timeout on a sick view must surface, never hide behind the slow query.
	timeout := &pgconn.PgError{Code: "57014", Message: "canceling statement due to statement timeout"}
	tried = nil
	_, err = readSuburbReference("test", func(src suburbReadSource) (string, error) {
		tried = append(tried, src)
		return "", timeout
	})
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "57014" || len(tried) != 1 {
		t.Fatalf("non-42P01 error: got %v after %v; want it returned with no fallback", err, tried)
	}
}
