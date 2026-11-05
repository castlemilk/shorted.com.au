package ownership

import (
	"context"
	"os"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5"
)

// The notice selections, run against real Postgres. Everything happens in one
// transaction whose temporary tables shadow the real ones, and it is rolled
// back, so nothing is committed. It runs only when OWNERSHIP_TEST_POSTGRES_URL
// is set.
func TestNoticeSelectionsAgainstPostgres(t *testing.T) {
	url := os.Getenv("OWNERSHIP_TEST_POSTGRES_URL")
	if url == "" {
		t.Skip("OWNERSHIP_TEST_POSTGRES_URL not set; skipping the real-Postgres selection test")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	for _, stmt := range []string{
		`CREATE TEMP TABLE asx_announcements (pdf_url text, stock_code varchar, announcement_date date, headline text)`,
		`CREATE TEMP TABLE substantial_holder_notice_attempts (announcement_url text PRIMARY KEY, stock_code varchar,
			outcome varchar, detail text, parser_version integer, attempts integer, attempted_at timestamptz DEFAULT now())`,
		`CREATE TEMP TABLE shorts ("PRODUCT_CODE" varchar, "DATE" date)`,
		// A notice about a delisted company, lodged by a live holder: listed under both codes.
		`INSERT INTO asx_announcements VALUES
			('u-dead-live', 'DEAD', current_date - 2, 'Ceasing to be a substantial holder from MQG'),
			('u-dead-live', 'MQG', current_date - 2, 'Ceasing to be a substantial holder from MQG')`,
		`INSERT INTO substantial_holder_notice_attempts (announcement_url, stock_code, outcome, parser_version, attempts)
			VALUES ('u-dead-live', 'DEAD', 'unavailable', 2, 1)`,
		// Only delisted codes: no live code, so an unavailable notice is not read again.
		`INSERT INTO asx_announcements VALUES ('u-dead-only', 'DEAD', current_date - 2, 'Becoming a substantial holder from DEAD')`,
		`INSERT INTO substantial_holder_notice_attempts (announcement_url, stock_code, outcome, parser_version, attempts)
			VALUES ('u-dead-only', 'DEAD', 'unavailable', 2, 1)`,
		// A fetch_error is read again by resolve.
		`INSERT INTO asx_announcements VALUES ('u-fetch', 'DEAD', current_date - 2, 'Change in substantial holding for MQG')`,
		`INSERT INTO substantial_holder_notice_attempts (announcement_url, stock_code, outcome, parser_version, attempts)
			VALUES ('u-fetch', 'DEAD', 'fetch_error', 3, 1)`,
		// Unavailable after the API path: already asked, not read again.
		`INSERT INTO asx_announcements VALUES ('u-asked', 'MQG', current_date - 2, 'Change in substantial holding')`,
		`INSERT INTO substantial_holder_notice_attempts (announcement_url, stock_code, outcome, parser_version, attempts)
			VALUES ('u-asked', 'MQG', 'unavailable', 3, 1)`,
		// A new notice, never attempted.
		`INSERT INTO asx_announcements VALUES ('u-new', 'MQG', current_date - 2, 'Change in substantial holding')`,
		`INSERT INTO shorts VALUES ('MQG', current_date - 1)`,
		// Two notices of one headline on one day under MQG, both parsed, so neither is
		// pending: the API cannot tell them apart. The headline's trailing space folds away.
		`INSERT INTO asx_announcements VALUES
			('u-share-a', 'MQG', current_date - 3, 'Becoming a substantial holder'),
			('u-share-b', 'MQG', current_date - 3, 'Becoming a substantial holder ')`,
		`INSERT INTO substantial_holder_notice_attempts (announcement_url, stock_code, outcome, parser_version, attempts)
			VALUES ('u-share-a', 'MQG', 'parsed', 3, 1), ('u-share-b', 'MQG', 'parsed', 3, 1)`,
	} {
		if _, err := tx.Exec(ctx, stmt); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}

	selectAll := func(sql string, args ...any) map[string]pendingNotice {
		t.Helper()
		rows, err := tx.Query(ctx, sql, args...)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		out := map[string]pendingNotice{}
		for rows.Next() {
			var p pendingNotice
			if err := rows.Scan(&p.URL, &p.AnnouncedOn, &p.Headline, &p.ListedCodes, &p.PriorOutcome, &p.PriorVersion); err != nil {
				t.Fatal(err)
			}
			out[p.URL] = p
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return out
	}

	// resolve-unavailable: the fetch_error and the live-coded unavailable notice,
	// with every listed code, so the target is settled on the whole listing.
	resolvable := selectAll(resolvableNoticesSQL, 10, "2025-01-01", noticeParserVersion)
	if len(resolvable) != 2 {
		t.Fatalf("resolvable notices = %v, want u-dead-live and u-fetch", keys(resolvable))
	}
	dl, ok := resolvable["u-dead-live"]
	if !ok {
		t.Fatalf("u-dead-live not selected: %v", keys(resolvable))
	}
	if want := []string{"DEAD", "MQG"}; !slices.Equal(dl.ListedCodes, want) {
		t.Errorf("u-dead-live codes = %v, want %v: the delisted code must stay in the listing", dl.ListedCodes, want)
	}
	if dl.PriorOutcome != outcomeUnavailable || dl.PriorVersion != 2 {
		t.Errorf("u-dead-live prior = %s v%d, want unavailable v2", dl.PriorOutcome, dl.PriorVersion)
	}
	// "from MQG" names the holder, so the target is the other code.
	companies := map[string]company{"MQG": {Code: "MQG", Name: "Macquarie Group Limited"}}
	if got, why := resolveTarget(dl, "", companies, map[string]bool{"MQG": true}); got != "DEAD" {
		t.Errorf("resolveTarget(u-dead-live) = %q (%s), want DEAD: the holder's code took the notice", got, why)
	}

	// The nightly pass: a new notice only. Recent attempts are not retried.
	pending := selectAll(pendingNoticesSQL, 10, "2025-01-01", noticeParserVersion, staleOutcomes(noticeParserVersion))
	if len(pending) != 1 || pending["u-new"].PriorVersion != 0 || pending["u-new"].PriorOutcome != "" {
		t.Errorf("pending notices = %v, want only the new notice with no prior attempt", keys(pending))
	}

	// The shared-headline guard: the feed holds both of MQG's notices of the day
	// with the headline (the trailing space folded), and nothing under DEAD or on
	// another day.
	shared := func(codes []string, day, headline string) int {
		t.Helper()
		var n int
		if err := tx.QueryRow(ctx, sharedHeadlineSQL, codes, day, headline).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	var day, otherDay string
	if err := tx.QueryRow(ctx, `SELECT (current_date - 3)::text, (current_date - 4)::text`).Scan(&day, &otherDay); err != nil {
		t.Fatal(err)
	}
	if got := shared([]string{"MQG"}, day, "Becoming a substantial holder"); got != 2 {
		t.Errorf("shared headline on the day = %d, want 2 (both notices, the trailing space folded)", got)
	}
	if got := shared([]string{"DEAD"}, day, "Becoming a substantial holder"); got != 0 {
		t.Errorf("shared headline under another code = %d, want 0", got)
	}
	if got := shared([]string{"MQG"}, otherDay, "Becoming a substantial holder"); got != 0 {
		t.Errorf("shared headline on another day = %d, want 0", got)
	}
}

func keys(m map[string]pendingNotice) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}
