package influence

// The re-crawl path, against a real Postgres.
//
// Every rule in this file is a SQL decision — what discover re-queues, what fetch
// resets, which artifact load accepts, whose identity a successor takes, when a
// predecessor retires — and string assertions on SQL have already shipped a
// query Postgres refused to run (see the price-drops capitulation fix). So these
// run the real statements against the real register DDL: each test builds a
// throwaway schema from the migrations themselves, so the tables cannot drift
// from what prod applies.
//
// REGISTER_TEST_DATABASE_URL only. This suite deliberately does NOT fall back to
// DATABASE_URL: services/.env holds the production URL, and these tests write.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// registerMigrations are the migrations that shape the tables this path touches,
// in apply order (000106 needs 000105's tables).
var registerMigrations = []string{
	"000096_add_register_of_interests.up.sql",
	"000098_add_entity_kind.up.sql",
	"000101_add_register_review_console.up.sql",
	"000102_add_politician_photos.up.sql",
	"000103_add_politician_profile_layer.up.sql",
	"000105_add_aec_donations.up.sql",
	"000106_add_senate_identity.up.sql",
	"000123_register_document_succession.up.sql",
}

type registerDB struct {
	t    *testing.T
	ctx  context.Context
	pool *pgxpool.Pool
}

func newRegisterDB(t *testing.T) *registerDB {
	t.Helper()
	url := os.Getenv("REGISTER_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set REGISTER_TEST_DATABASE_URL (a local database — never prod) to run the register re-crawl tests")
	}
	if strings.Contains(url, "supabase") || strings.Contains(url, "pooler") {
		t.Fatalf("REGISTER_TEST_DATABASE_URL points at a hosted database; these tests write")
	}
	ctx := context.Background()

	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer admin.Close()

	schema := fmt.Sprintf("register_test_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}

	_, thisFile, _, _ := runtime.Caller(0)
	migrations := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "..", "migrations")

	conn, err := admin.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if _, err := conn.Exec(ctx, `SET search_path = `+schema+`, public`); err != nil {
		t.Fatalf("search_path: %v", err)
	}
	for _, m := range registerMigrations {
		sql, err := os.ReadFile(filepath.Join(migrations, m))
		if err != nil {
			t.Fatalf("read %s: %v", m, err)
		}
		// No arguments -> simple protocol, so a multi-statement file runs whole.
		if _, err := conn.Exec(ctx, string(sql)); err != nil {
			conn.Release()
			t.Fatalf("apply %s: %v", m, err)
		}
	}
	conn.Release()

	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatalf("parse config: %v", err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema + ", public"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("open pool: %v", err)
	}

	t.Cleanup(func() {
		pool.Close()
		cleanup, err := pgxpool.New(ctx, url)
		if err != nil {
			t.Logf("could not reopen to drop %s: %v", schema, err)
			return
		}
		defer cleanup.Close()
		if _, err := cleanup.Exec(ctx, `DROP SCHEMA IF EXISTS `+schema+` CASCADE`); err != nil {
			t.Errorf("schema %s left behind: %v", schema, err)
		}
	})
	return &registerDB{t: t, ctx: ctx, pool: pool}
}

func (db *registerDB) exec(sql string, args ...any) {
	db.t.Helper()
	if _, err := db.pool.Exec(db.ctx, sql, args...); err != nil {
		db.t.Fatalf("%s: %v", strings.Fields(sql)[0], err)
	}
}

func (db *registerDB) scalar(dest any, sql string, args ...any) {
	db.t.Helper()
	if err := db.pool.QueryRow(db.ctx, sql, args...).Scan(dest); err != nil {
		db.t.Fatalf("query %q: %v", sql, err)
	}
}

func (db *registerDB) dbNow() time.Time {
	db.t.Helper()
	var now time.Time
	db.scalar(&now, `SELECT clock_timestamp()`)
	return now
}

// document inserts a House manifest row in a chosen state and returns its id.
func (db *registerDB) document(url, hint, division string, fetchStatus, extractStatus, sha string, fetchedAt time.Time) string {
	db.t.Helper()
	var id string
	db.scalar(&id, `
		INSERT INTO register_documents
			(source_url, listing_url, chamber, parliament, member_hint, division_hint,
			 fetch_status, fetched_at, content_sha256, classify_status, text_class,
			 extract_status, discovered_at)
		VALUES ($1, 'https://www.aph.gov.au/listing', 'house', 48, $2, $3,
		        $4, $5, NULLIF($6, ''), 'classified', 'text', $7, $5)
		RETURNING id::text`, url, hint, division, fetchStatus, fetchedAt, sha, extractStatus)
	return id
}

// extraction stores an artifact of `sha` for a document. Each item's text is
// tagged with the document so a reader can tell whose rows published.
func (db *registerDB) extraction(documentID, sha, tag string, unreadable bool) {
	db.t.Helper()
	stmt := map[string]any{
		"ordinal": 1, "kind": "base", "lodged_date": "2025-08-01", "date_is_stated": true,
		"page_from": 1, "page_to": 1,
		"items": []map[string]any{{
			"item_no": 1, "item_label": "Shareholdings", "page_no": 1,
			"rows": []map[string]any{{"holder": "self", "change_type": "declared", "ordinal": 1,
				"declared_text": "ZZTEST " + tag, "page_no": 1}},
		}},
	}
	if unreadable {
		stmt["warnings"] = []string{"tables_unparsed"}
	}
	payload, _ := json.Marshal(map[string]any{
		"schema_version": "test", "document_sha256": sha, "chamber": "house", "parliament": 48,
		"statements": []any{stmt},
	})
	db.exec(`
		INSERT INTO register_extractions
			(document_id, content_sha256, schema_version, extractor_name, extractor_version, tier, payload)
		VALUES ($1, $2, 'test', 'test', $3, 'deterministic', $4)`, documentID, sha, "v-"+tag, payload)
}

func (db *registerDB) loadQueue() map[string]pendingExtraction {
	db.t.Helper()
	pending, err := selectExtractionsToLoad(db.ctx, db.pool, 0)
	if err != nil {
		db.t.Fatalf("selectExtractionsToLoad: %v", err)
	}
	out := map[string]pendingExtraction{}
	for _, p := range pending {
		out[p.DocumentID] = p
	}
	return out
}

func (db *registerDB) mustLoad(p pendingExtraction) loadOutcome {
	db.t.Helper()
	res, err := loadExtraction(db.ctx, db.pool, p)
	if err != nil {
		db.t.Fatalf("loadExtraction(%s): %v", p.SourceURL, err)
	}
	return res
}

func sydney(t *testing.T, s string) time.Time {
	t.Helper()
	loc, err := time.LoadLocation("Australia/Sydney")
	if err != nil {
		t.Fatalf("tz: %v", err)
	}
	v, err := time.ParseInLocation("2006-01-02 15:04", s, loc)
	if err != nil {
		t.Fatalf("parse %s: %v", s, err)
	}
	return v
}

func listingDate(t *testing.T, s string) *time.Time {
	t.Helper()
	v, err := time.Parse("2006-01-02", s)
	if err != nil {
		t.Fatalf("parse %s: %v", s, err)
	}
	return &v
}

// ---------------------------------------------------------------------------

func TestDiscoverRequeuesOnlyWhatAPHListsAsChanged(t *testing.T) {
	db := newRegisterDB(t)
	fetched := sydney(t, "2026-08-01 10:00")

	amendedSameDay := db.document("https://www.aph.gov.au/-/media/a.pdf", "Zza, Ms A, Member for Aa, VIC", "Aa", "fetched", "extracted", "sha-a", fetched)
	unchanged := db.document("https://www.aph.gov.au/-/media/b.pdf", "Zzb, Ms B, Member for Bb, VIC", "Bb", "fetched", "extracted", "sha-b", fetched)
	blocked := db.document("https://www.aph.gov.au/-/media/c.pdf", "Zzc, Ms C, Member for Cc, VIC", "Cc", "blocked", "pending", "", fetched)
	db.exec(`UPDATE register_documents SET fetch_attempts = 2 WHERE id = $1`, amendedSameDay)

	listedAt := db.dbNow()
	listing := []RegisterDocument{
		// Listed the same Sydney day we fetched: a later amendment that day is
		// indistinguishable from none, so it is re-fetched.
		{SourceURL: "https://www.aph.gov.au/-/media/a.pdf", ListingURL: "l", Chamber: "house", Parliament: 48, MemberHint: "Zza, Ms A, Member for Aa VIC", DivisionHint: "Aa", LastUpdatedAt: listingDate(t, "2026-08-01")},
		{SourceURL: "https://www.aph.gov.au/-/media/b.pdf", ListingURL: "l", Chamber: "house", Parliament: 48, MemberHint: "Zzb, Ms B, Member for Bb VIC", DivisionHint: "Bb", LastUpdatedAt: listingDate(t, "2026-07-31")},
		{SourceURL: "https://www.aph.gov.au/-/media/c.pdf", ListingURL: "l", Chamber: "house", Parliament: 48, MemberHint: "Zzc, Ms C, Member for Cc VIC", DivisionHint: "Cc", LastUpdatedAt: listingDate(t, "2026-09-01")},
		{SourceURL: "https://interests-register-api-public.aph.gov.au/api/members/9/statement/48", ListingURL: "l", Chamber: "house", Parliament: 48, MemberHint: "Zzd, Ms D, Member for Dd VIC", DivisionHint: "Dd", LastUpdatedAt: listingDate(t, "2026-09-01")},
	}
	if _, err := upsertRegisterDocuments(db.ctx, db.pool, listing, listedAt); err != nil {
		t.Fatalf("upsert: %v", err)
	}

	check := func(id, wantFetch string, wantAttempts int, what string) {
		t.Helper()
		var status string
		var attempts int
		var listed *time.Time
		if err := db.pool.QueryRow(db.ctx, `SELECT fetch_status, fetch_attempts, last_listed_at FROM register_documents WHERE id = $1`, id).
			Scan(&status, &attempts, &listed); err != nil {
			t.Fatal(err)
		}
		if status != wantFetch || attempts != wantAttempts {
			t.Errorf("%s: fetch_status=%s attempts=%d, want %s/%d", what, status, attempts, wantFetch, wantAttempts)
		}
		if listed == nil || !listed.Equal(listedAt) {
			t.Errorf("%s: last_listed_at=%v, want the run clock %v", what, listed, listedAt)
		}
	}
	check(amendedSameDay, "pending", 0, "amended on the fetch day")
	check(unchanged, "fetched", 0, "listed before the fetch")
	check(blocked, "blocked", 0, "blocked (a WAF signal is never re-queued away)")

	var discovered time.Time
	db.scalar(&discovered, `SELECT discovered_at FROM register_documents WHERE source_url LIKE '%/api/members/9/%'`)
	if !discovered.Equal(listedAt) {
		t.Errorf("new row discovered_at=%v, want the run clock %v (succession compares the two exactly)", discovered, listedAt)
	}

	var extract string
	db.scalar(&extract, `SELECT extract_status FROM register_documents WHERE id = $1`, amendedSameDay)
	if extract != "extracted" {
		t.Errorf("re-queue touched extract_status (%s); the document must keep publishing until its new file extracts", extract)
	}
}

func TestFetchResetsClassificationOnlyWhenTheBytesChanged(t *testing.T) {
	db := newRegisterDB(t)
	id := db.document("https://www.aph.gov.au/-/media/x.pdf", "Zzx, Ms X, Member for Xx, VIC", "Xx", "pending", "extracted", "sha-old", time.Now())

	if err := markDocumentFetched(db.ctx, db.pool, id, FetchResult{SHA256: "sha-old", ByteSize: 1, StorageURI: "gs://b/o", HTTPStatus: 200}); err != nil {
		t.Fatal(err)
	}
	var classify string
	db.scalar(&classify, `SELECT classify_status FROM register_documents WHERE id = $1`, id)
	if classify != "classified" {
		t.Errorf("unchanged bytes reset classification to %s", classify)
	}

	if err := markDocumentFetched(db.ctx, db.pool, id, FetchResult{SHA256: "sha-new", ByteSize: 2, StorageURI: "gs://b/n", HTTPStatus: 200}); err != nil {
		t.Fatal(err)
	}
	var extract string
	if err := db.pool.QueryRow(db.ctx, `SELECT classify_status, extract_status FROM register_documents WHERE id = $1`, id).Scan(&classify, &extract); err != nil {
		t.Fatal(err)
	}
	if classify != "pending" {
		t.Errorf("changed bytes kept classify_status=%s; page_count would describe the old file", classify)
	}
	if extract != "extracted" {
		t.Errorf("changed bytes moved extract_status to %s; the old rows must keep publishing until re-extraction", extract)
	}
}

func TestLoadNeverPublishesAnArtifactOfReplacedBytes(t *testing.T) {
	db := newRegisterDB(t)
	id := db.document("https://www.aph.gov.au/-/media/y.pdf", "Zzy, Ms Y, Member for Yy, VIC", "Yy", "fetched", "extracted", "sha-new", time.Now())
	db.extraction(id, "sha-old", "old-file", false)

	if _, queued := db.loadQueue()[id]; queued {
		t.Fatal("load selected an artifact of bytes the document no longer holds")
	}
	db.extraction(id, "sha-new", "new-file", false)
	if _, queued := db.loadQueue()[id]; !queued {
		t.Fatal("load did not select the artifact of the current bytes")
	}
}

// The whole reason for succession: "Antony" became "Tony" when APH moved the
// register. Loading the new row by name would mint a second Pasin.
func TestSuccessorCarriesIdentityAndRetiresItsPredecessorAtomically(t *testing.T) {
	db := newRegisterDB(t)
	old := db.document(
		"https://www.aph.gov.au/-/media/03_Senators_and_Members/32_Members/Register/48p/PS/Zzpasin_48P.pdf",
		"Zzpasin, Mr Antony, Member for Barker, SA", "Barker", "fetched", "extracted", "sha-old", sydney(t, "2026-07-25 09:00"))
	db.extraction(old, "sha-old", "old-doc", false)
	db.mustLoad(db.loadQueue()[old])

	var person string
	db.scalar(&person, `SELECT id::text FROM politicians WHERE person_key = 'ZZPASIN|ANTONY'`)

	// Discover: the listing now carries only the API row, with the edited name.
	listedAt := db.dbNow()
	newURL := "https://interests-register-api-public.aph.gov.au/api/members/240756/statement/48"
	if _, err := upsertRegisterDocuments(db.ctx, db.pool, []RegisterDocument{{
		SourceURL: newURL, ListingURL: "l", Chamber: "house", Parliament: 48,
		MemberHint: "Zzpasin, Mr Tony, Member for Barker SA", DivisionHint: "Barker", StateHint: "SA",
		LastUpdatedAt: listingDate(t, "2026-09-01"),
	}}, listedAt); err != nil {
		t.Fatal(err)
	}
	stats, err := recordHouseSuccession(db.ctx, db.pool, listedAt, []int{48})
	if err != nil {
		t.Fatal(err)
	}
	if stats.Linked != 1 || stats.Unpaired != 0 {
		t.Fatalf("succession = %+v, want 1 linked", stats)
	}

	var successor string
	db.scalar(&successor, `SELECT id::text FROM register_documents WHERE source_url = $1`, newURL)
	db.exec(`UPDATE register_documents SET fetch_status='fetched', fetched_at=now(), content_sha256='sha-new',
	         classify_status='classified', text_class='text', extract_status='extracted' WHERE id = $1`, successor)
	db.extraction(successor, "sha-new", "new-doc", false)

	queue := db.loadQueue()
	if _, ok := queue[old]; ok {
		t.Error("a superseded document is still in the load queue")
	}
	// Until the successor loads, the predecessor keeps publishing.
	var published int
	db.scalar(&published, `SELECT count(*) FROM register_statements WHERE document_id = $1`, old)
	if published == 0 {
		t.Fatal("the predecessor stopped publishing before its successor loaded")
	}

	res := db.mustLoad(queue[successor])
	if !res.Carried || res.Retired != 1 {
		t.Fatalf("outcome = %+v, want identity carried and one predecessor retired", res)
	}

	var people, tonyRows int
	db.scalar(&people, `SELECT count(*) FROM politicians`)
	db.scalar(&tonyRows, `SELECT count(*) FROM politicians WHERE person_key = 'ZZPASIN|TONY'`)
	if people != 1 || tonyRows != 0 {
		t.Fatalf("politicians=%d (ZZPASIN|TONY rows=%d): the successor minted a second person", people, tonyRows)
	}

	var owner string
	db.scalar(&owner, `SELECT DISTINCT politician_id::text FROM register_statements`)
	if owner != person {
		t.Errorf("statements publish under %s, want the carried person %s", owner, person)
	}
	var texts []string
	rows, err := db.pool.Query(db.ctx, `SELECT declared_text FROM register_declared_items ORDER BY 1`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var s string
		_ = rows.Scan(&s)
		texts = append(texts, s)
	}
	rows.Close()
	if strings.Join(texts, ",") != "ZZTEST new-doc" {
		t.Errorf("published items = %v, want only the successor's (no duplicates)", texts)
	}

	var status, reason string
	if err := db.pool.QueryRow(db.ctx, `SELECT extract_status, extract_error FROM register_documents WHERE id = $1`, old).Scan(&status, &reason); err != nil {
		t.Fatal(err)
	}
	if status != "skipped" || !strings.Contains(reason, newURL) {
		t.Errorf("predecessor extract_status=%s error=%q, want skipped and superseded by the successor", status, reason)
	}
	var alias string
	db.scalar(&alias, `SELECT politician_id::text FROM politician_aliases WHERE alias_key = 'ZZPASIN|TONY'`)
	if alias != person {
		t.Errorf("the new spelling was not recorded as an alias of the carried person")
	}

	// register-load reloads every extracted document on every run. After the
	// predecessor is retired there is nothing left to carry from, so the reload
	// must hold the person the successor already publishes under — even when the
	// new spelling's alias never got recorded because another person owned it.
	db.exec(`DELETE FROM politician_aliases WHERE alias_key = 'ZZPASIN|TONY'`)
	db.exec(`INSERT INTO politicians (person_key, surname, given_names, display_name, slug)
	         VALUES ('ZZPASIN|TONY', 'Zzpasin', 'Tony', 'Tony Zzpasin', 'zztest-someone-else')`)
	reload := db.mustLoad(db.loadQueue()[successor])
	if !reload.Carried || reload.Retired != 0 {
		t.Errorf("reload outcome = %+v, want identity still carried and nothing newly retired", reload)
	}
	var reloadOwner string
	db.scalar(&reloadOwner, `SELECT DISTINCT politician_id::text FROM register_statements`)
	if reloadOwner != person {
		t.Fatalf("a reload moved the member's declarations to %s (want %s): identity must not drift between runs", reloadOwner, person)
	}

	// The load queue was read once at the start of a run; a predecessor retired
	// by an earlier document in that run must not be loaded back.
	stale := pendingExtraction{DocumentID: old, SourceURL: "stale", Chamber: "house", Parliament: 48,
		MemberHint: "Zzpasin, Mr Antony, Member for Barker, SA", DivisionHint: "Barker", ExtractionSHA: "sha-old",
		Payload: []byte(`{"statements":[]}`)}
	if _, err := loadExtraction(db.ctx, db.pool, stale); err == nil {
		t.Error("a retired predecessor loaded again from a stale queue entry")
	}
}

// A successor whose every statement is unreadable must not replace a member's
// declarations with nothing.
func TestUnreadableSuccessorLeavesThePredecessorPublishing(t *testing.T) {
	db := newRegisterDB(t)
	old := db.document("https://www.aph.gov.au/-/media/old.pdf", "Zzkeep, Ms Kay, Member for Mayo, SA", "Mayo", "fetched", "extracted", "sha-old", sydney(t, "2026-07-25 09:00"))
	db.extraction(old, "sha-old", "old-doc", false)
	db.mustLoad(db.loadQueue()[old])

	listedAt := db.dbNow()
	newURL := "https://interests-register-api-public.aph.gov.au/api/members/77/statement/48"
	if _, err := upsertRegisterDocuments(db.ctx, db.pool, []RegisterDocument{{SourceURL: newURL, ListingURL: "l", Chamber: "house", Parliament: 48,
		MemberHint: "Zzkeep, Ms Kay, Member for Mayo SA", DivisionHint: "Mayo"}}, listedAt); err != nil {
		t.Fatal(err)
	}
	if _, err := recordHouseSuccession(db.ctx, db.pool, listedAt, []int{48}); err != nil {
		t.Fatal(err)
	}
	var successor string
	db.scalar(&successor, `SELECT id::text FROM register_documents WHERE source_url = $1`, newURL)
	db.exec(`UPDATE register_documents SET fetch_status='fetched', content_sha256='sha-new', extract_status='extracted' WHERE id = $1`, successor)
	db.extraction(successor, "sha-new", "new-doc", true)

	res := db.mustLoad(db.loadQueue()[successor])
	if res.Statements != 0 || res.Retired != 0 {
		t.Fatalf("outcome = %+v, want nothing published and nothing retired", res)
	}
	var published int
	var status string
	db.scalar(&published, `SELECT count(*) FROM register_statements WHERE document_id = $1`, old)
	db.scalar(&status, `SELECT extract_status FROM register_documents WHERE id = $1`, old)
	if published == 0 || status != "extracted" {
		t.Errorf("predecessor published=%d status=%s; an unreadable successor blanked a member", published, status)
	}
}

// One departure, one arrival, different people in the same seat: never guessed.
func TestLoadWithholdsANewDocumentBesideAnUnpairedDeparture(t *testing.T) {
	db := newRegisterDB(t)
	old := db.document("https://www.aph.gov.au/-/media/former.pdf", "Zzformer, Mr Alan, Member for Aston, VIC", "Aston", "fetched", "extracted", "sha-old", sydney(t, "2026-07-25 09:00"))
	db.extraction(old, "sha-old", "former", false)
	db.mustLoad(db.loadQueue()[old])

	listedAt := db.dbNow()
	newURL := "https://interests-register-api-public.aph.gov.au/api/members/55/statement/48"
	if _, err := upsertRegisterDocuments(db.ctx, db.pool, []RegisterDocument{{SourceURL: newURL, ListingURL: "l", Chamber: "house", Parliament: 48,
		MemberHint: "Zznewcomer, Ms Mary, Member for Aston VIC", DivisionHint: "Aston"}}, listedAt); err != nil {
		t.Fatal(err)
	}
	stats, err := recordHouseSuccession(db.ctx, db.pool, listedAt, []int{48})
	if err != nil {
		t.Fatal(err)
	}
	if stats.Linked != 0 || stats.Unpaired != 1 {
		t.Fatalf("succession = %+v, want the two people left unpaired", stats)
	}

	var successor string
	db.scalar(&successor, `SELECT id::text FROM register_documents WHERE source_url = $1`, newURL)
	db.exec(`UPDATE register_documents SET fetch_status='fetched', content_sha256='sha-new', extract_status='extracted' WHERE id = $1`, successor)
	db.extraction(successor, "sha-new", "newcomer", false)

	_, err = loadExtraction(db.ctx, db.pool, db.loadQueue()[successor])
	if _, withheld := err.(*errLoadWithheld); !withheld {
		t.Fatalf("err = %v, want the new document withheld", err)
	}
	var people int
	db.scalar(&people, `SELECT count(*) FROM politicians`)
	if people != 1 {
		t.Errorf("politicians = %d; a withheld document must not mint anyone", people)
	}

	// A person resolves it (here: the newcomer genuinely replaced nobody, so the
	// departed row is marked as superseded by hand) and the load goes through.
	db.exec(`UPDATE register_documents SET superseded_by = $1 WHERE id = $2`, successor, old)
	res, err := loadExtraction(db.ctx, db.pool, db.loadQueue()[successor])
	if err != nil {
		t.Fatalf("load after a manual decision: %v", err)
	}
	if res.Statements != 1 {
		t.Errorf("outcome = %+v", res)
	}
}

func TestFreshnessMeasuresTheListingNotTheFetch(t *testing.T) {
	db := newRegisterDB(t)
	now := time.Now()
	id := db.document("https://www.aph.gov.au/-/media/q.pdf", "Zzq, Ms Q, Member for Qq, VIC", "Qq", "fetched", "extracted", "sha-q", now.AddDate(0, 0, -60))
	db.extraction(id, "sha-q", "q", false)
	db.exec(`UPDATE register_documents SET last_listed_at = now() - interval '2 days' WHERE id = $1`, id)

	// A retired predecessor is 'skipped' by design and must not read as backlog.
	skipped := db.document("https://www.aph.gov.au/-/media/s.pdf", "Zzs, Ms S, Member for Ss, VIC", "Ss", "fetched", "skipped", "sha-s", now.AddDate(0, 0, -60))
	db.exec(`UPDATE register_documents SET superseded_by = $1 WHERE id = $2`, id, skipped)

	checks, err := collectRegisterFreshness(db.ctx, db.pool, now)
	if err != nil {
		t.Fatal(err)
	}
	status := map[string]string{}
	for _, c := range checks {
		status[c.Name] = c.Status
	}
	if status["aph-staleness"] != "OK" {
		t.Errorf("aph-staleness = %s: a 60-day-old fetch with a fresh listing read is a quiet recess, not a dead crawl", status["aph-staleness"])
	}
	if status["aph-extract-backlog"] != "OK" {
		t.Errorf("aph-extract-backlog = %s: a superseded document counted as unparsed", status["aph-extract-backlog"])
	}

	// Changed bytes with no extraction yet: that IS backlog, even though the
	// document is still 'extracted'.
	db.exec(`UPDATE register_documents SET content_sha256 = 'sha-q2', fetched_at = now() - interval '20 days' WHERE id = $1`, id)
	// And a queue left behind by a listing read 10 days ago.
	db.exec(`UPDATE register_documents SET last_listed_at = now() - interval '10 days'`)
	db.document("https://www.aph.gov.au/-/media/p.pdf", "Zzp, Ms P, Member for Pp, VIC", "Pp", "pending", "pending", "", now)

	checks, err = collectRegisterFreshness(db.ctx, db.pool, now)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range checks {
		status[c.Name] = c.Status
	}
	if status["aph-extract-backlog"] != "ALARM" {
		t.Errorf("aph-extract-backlog = %s: re-fetched bytes waiting 20 days for extraction must alarm", status["aph-extract-backlog"])
	}
	if status["aph-fetch-backlog"] != "ALARM" {
		t.Errorf("aph-fetch-backlog = %s: a queue 10 days after the listing read must alarm", status["aph-fetch-backlog"])
	}
}
