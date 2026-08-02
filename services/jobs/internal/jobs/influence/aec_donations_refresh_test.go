package influence

// The refresh is the step where a silent failure is most expensive: the load has
// already replaced the base tables, so a rollup that did not rebuild describes a
// snapshot that no longer exists — under a fresh timestamp, on a public page.
//
// The failure path is therefore tested, not assumed. Each case SHADOWS the real
// refresh function in a throwaway schema and puts that schema first on the
// connection's search_path, so the production function is never redefined and
// nothing outside the test schema is touched.

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// shadowRefreshPool returns a pool whose search_path resolves
// refresh_aec_donations_materialized_views() to the given plpgsql body, while
// aec_refresh_log still resolves to the real table in public.
func shadowRefreshPool(t *testing.T, body string) (*pgxpool.Pool, string) {
	t.Helper()
	url := os.Getenv("AEC_TEST_DATABASE_URL")
	if url == "" {
		url = os.Getenv("DATABASE_URL")
	}
	if url == "" {
		t.Skip("set AEC_TEST_DATABASE_URL or DATABASE_URL to run the refresh tests")
	}
	ctx := context.Background()

	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Skipf("connect: %v", err)
	}
	defer admin.Close()
	if err := admin.Ping(ctx); err != nil {
		t.Skipf("ping: %v", err)
	}

	schema := "aec_refresh_shadow"
	if _, err := admin.Exec(ctx, `DROP SCHEMA IF EXISTS `+schema+` CASCADE`); err != nil {
		t.Skipf("prepare shadow schema: %v", err)
	}
	if _, err := admin.Exec(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Skipf("create shadow schema: %v", err)
	}
	if _, err := admin.Exec(ctx, fmt.Sprintf(`
		CREATE FUNCTION %s.refresh_aec_donations_materialized_views()
		RETURNS BOOLEAN LANGUAGE plpgsql AS $shadow$
		BEGIN
			%s
		END;
		$shadow$`, schema, body)); err != nil {
		t.Fatalf("create shadow function: %v", err)
	}

	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatalf("parse config: %v", err)
	}
	if cfg.ConnConfig.RuntimeParams == nil {
		cfg.ConnConfig.RuntimeParams = map[string]string{}
	}
	// The shadow first, public second: the log table still writes where the
	// operator will look for it.
	cfg.ConnConfig.RuntimeParams["search_path"] = schema + ",public"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("open shadowed pool: %v", err)
	}

	t.Cleanup(func() {
		pool.Close()
		cleanup, err := pgxpool.New(ctx, url)
		if err != nil {
			t.Logf("could not reopen to drop the shadow schema: %v", err)
			return
		}
		defer cleanup.Close()
		if _, err := cleanup.Exec(ctx, `DROP SCHEMA IF EXISTS `+schema+` CASCADE`); err != nil {
			t.Errorf("the shadow schema was left behind: %v", err)
		}
	})
	return pool, schema
}

func latestRefreshLog(t *testing.T, pool *pgxpool.Pool) (succeeded bool, method, detail string, found bool) {
	t.Helper()
	rows, err := pool.Query(context.Background(), `
		SELECT succeeded, method, detail FROM public.aec_refresh_log
		ORDER BY refreshed_at DESC LIMIT 1`)
	if err != nil {
		t.Fatalf("read refresh log: %v", err)
	}
	defer rows.Close()
	if !rows.Next() {
		return false, "", "", false
	}
	if err := rows.Scan(&succeeded, &method, &detail); err != nil {
		t.Fatalf("scan refresh log: %v", err)
	}
	return succeeded, method, detail, true
}

// A refresh that raises must reach the caller. Before the fix the SQL caught
// every error into a WARNING, so this call could not fail and the mode logged a
// successful run over a rollup that had not been rebuilt.
func TestRefreshFailureReachesTheCaller(t *testing.T) {
	pool, _ := shadowRefreshPool(t, `RAISE EXCEPTION 'simulated refresh failure';`)

	err := refreshAECDonationsViews(context.Background(), pool)
	if err == nil {
		t.Fatal("a failing refresh returned no error; the ingest would report success over a stale rollup")
	}
	if !strings.Contains(err.Error(), "refresh aec materialized views") {
		t.Errorf("error does not name the failing step: %v", err)
	}

	succeeded, method, detail, found := latestRefreshLog(t, pool)
	if !found {
		t.Fatal("the failure was not recorded in aec_refresh_log")
	}
	if succeeded {
		t.Error("the latest refresh log row claims success after a failure")
	}
	if method != "failed" {
		t.Errorf("logged method = %q, want failed", method)
	}
	if !strings.Contains(detail, "simulated refresh failure") {
		t.Errorf("the log row does not say what went wrong: %q", detail)
	}
}

// And a refresh that merely REPORTS failure — returning false rather than
// raising — must be treated exactly the same way.
func TestRefreshReportingFalseIsAFailure(t *testing.T) {
	pool, _ := shadowRefreshPool(t, `RETURN FALSE;`)

	err := refreshAECDonationsViews(context.Background(), pool)
	if err == nil {
		t.Fatal("a refresh reporting failure was accepted as success")
	}
	succeeded, _, _, found := latestRefreshLog(t, pool)
	if !found || succeeded {
		t.Error("a reported failure was not recorded as one")
	}
}
