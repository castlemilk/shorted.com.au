package ownershipsemantics

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// This test never chooses an ambient app DSN. It accepts only the runner's
// disposable loopback database and uses a unique schema, dropped at the end.
// CI sets REQUIRE_DATABASE=1, so missing prerequisites cannot produce green
// skipped integration evidence.
func TestPostgresSemanticRevisions(t *testing.T) {
	dsn := os.Getenv("OWNERSHIP_SEMANTICS_TEST_DATABASE_URL")
	if dsn == "" {
		if os.Getenv("OWNERSHIP_SEMANTICS_REQUIRE_DATABASE") == "1" {
			t.Fatal("OWNERSHIP_SEMANTICS_TEST_DATABASE_URL is required")
		}
		t.Skip("set OWNERSHIP_SEMANTICS_TEST_DATABASE_URL to the disposable test database")
	}
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if !oneOf(config.ConnConfig.Host, "127.0.0.1", "::1", "localhost") || config.ConnConfig.Database != "shorted_ownership_semantics_test" {
		t.Fatal("refusing a non-loopback or non-test ownership database")
	}
	for _, fallback := range config.ConnConfig.Fallbacks {
		if !oneOf(fallback.Host, "127.0.0.1", "::1", "localhost") {
			t.Fatal("refusing a non-loopback database fallback")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close(context.Background()) }()
	random := make([]byte, 12)
	if _, err := rand.Read(random); err != nil {
		t.Fatal(err)
	}
	schema := "ownership_semantics_test_" + hex.EncodeToString(random)
	quotedSchema := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quotedSchema); err != nil {
		t.Fatal(err)
	}
	defer func() {
		clean, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		if _, err := admin.Exec(clean, "DROP SCHEMA "+quotedSchema+" CASCADE"); err != nil {
			t.Errorf("isolated schema cleanup: %v", err)
		}
	}()
	config.ConnConfig.RuntimeParams["search_path"] = quotedSchema + ",pg_catalog"
	config.ConnConfig.RuntimeParams["statement_timeout"] = "15000"
	config.ConnConfig.RuntimeParams["lock_timeout"] = "5000"
	config.MaxConns = 16
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	store := NewStore(pool)
	// Simulate hosted default grants only inside this disposable schema.
	// Roles created by this test are removed after schema/default-ACL cleanup.
	readerRole := "ownership_semantics_reader_" + hex.EncodeToString(random)
	createdRoles := []string{}
	t.Cleanup(func() {
		clean, stop := context.WithTimeout(context.Background(), 15*time.Second)
		defer stop()
		conn, err := pgx.Connect(clean, dsn)
		if err != nil {
			t.Errorf("role cleanup connection: %v", err)
			return
		}
		defer func() { _ = conn.Close(clean) }()
		for _, role := range createdRoles {
			if _, err := conn.Exec(clean, "DROP ROLE "+pgx.Identifier{role}.Sanitize()); err != nil {
				t.Errorf("test role cleanup %s: %v", role, err)
			}
		}
	})
	for _, role := range []string{"anon", "authenticated", "service_role", readerRole} {
		var exists bool
		if err := admin.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)`, role).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if !exists {
			if _, err := admin.Exec(ctx, "CREATE ROLE "+pgx.Identifier{role}.Sanitize()+" NOLOGIN"); err != nil {
				t.Fatal(err)
			}
			createdRoles = append(createdRoles, role)
		}
		if _, err := admin.Exec(ctx, "GRANT USAGE ON SCHEMA "+quotedSchema+" TO "+pgx.Identifier{role}.Sanitize()); err != nil {
			t.Fatal(err)
		}
	}
	for _, object := range []string{"TABLES", "FUNCTIONS"} {
		if _, err := admin.Exec(ctx, "ALTER DEFAULT PRIVILEGES IN SCHEMA "+quotedSchema+" GRANT ALL ON "+object+" TO PUBLIC, anon, authenticated, service_role"); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("uninstalled_storage_fails_explicitly", func(t *testing.T) {
		prepared, _ := Prepare(syntheticInput())
		if _, err := store.Get(ctx, prepared.RevisionID); !errors.Is(err, ErrSchemaUnavailable) {
			t.Fatalf("get: %v", err)
		}
		if _, _, err := store.Append(ctx, syntheticInput()); !errors.Is(err, ErrSchemaUnavailable) {
			t.Fatalf("append: %v", err)
		}
	})
	migration, err := os.ReadFile(filepath.Join("..", "..", "migrations", "000161_ownership_semantic_revisions.up.sql"))
	if err != nil {
		t.Fatal(err)
	}
	t.Run("migration_replays_without_legacy_schema_or_rows", func(t *testing.T) {
		for i := 0; i < 2; i++ {
			if _, err := pool.Exec(ctx, string(migration)); err != nil {
				t.Fatal(err)
			}
		}
		var oldTable *string
		if err := pool.QueryRow(ctx, `SELECT to_regclass('substantial_holder_notices')::text`).Scan(&oldTable); err != nil {
			t.Fatal(err)
		}
		if oldTable != nil {
			t.Fatal("migration created or required a legacy parsed notice table")
		}
		var triggerCount int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_trigger WHERE tgrelid = 'ownership_disclosure_revisions'::regclass AND NOT tgisinternal`).Scan(&triggerCount); err != nil {
			t.Fatal(err)
		}
		if triggerCount != 1 {
			t.Fatalf("immutability trigger count = %d", triggerCount)
		}
	})
	t.Run("migration_closes_default_data_api_grants_and_enables_rls", func(t *testing.T) {
		for _, role := range []string{"anon", "authenticated", readerRole} {
			var tableGrant, functionGrant bool
			if err := pool.QueryRow(ctx, `SELECT
				has_table_privilege($1, 'ownership_disclosure_revisions', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
				has_function_privilege($1, 'ownership_disclosure_revisions_immutable()', 'EXECUTE')`, role).Scan(&tableGrant, &functionGrant); err != nil {
				t.Fatal(err)
			}
			if tableGrant || functionGrant {
				t.Fatalf("public/default privileges remain for %s: table=%v routine=%v", role, tableGrant, functionGrant)
			}
		}
		var rls, forced, serviceTable, serviceFunction bool
		var policies int
		if err := pool.QueryRow(ctx, `SELECT relrowsecurity, relforcerowsecurity,
			(SELECT count(*) FROM pg_policy WHERE polrelid = c.oid)
			FROM pg_class c WHERE c.oid = 'ownership_disclosure_revisions'::regclass`).Scan(&rls, &forced, &policies); err != nil {
			t.Fatal(err)
		}
		if !rls || forced || policies != 0 {
			t.Fatalf("RLS shape: enabled=%v forced=%v policies=%d", rls, forced, policies)
		}
		if err := pool.QueryRow(ctx, `SELECT
			has_table_privilege('service_role', 'ownership_disclosure_revisions', 'SELECT'),
			has_function_privilege('service_role', 'ownership_disclosure_revisions_immutable()', 'EXECUTE')`).Scan(&serviceTable, &serviceFunction); err != nil {
			t.Fatal(err)
		}
		if !serviceTable || !serviceFunction {
			t.Fatal("migration changed explicit service_role grants contrary to 000138")
		}
	})
	if _, err := pool.Exec(ctx, `CREATE TABLE substantial_holder_notices (
		announcement_url text PRIMARY KEY, form varchar(3), previous_pct numeric(7,4), present_pct numeric(7,4));
		INSERT INTO substantial_holder_notices VALUES ('legacy-sentinel', '604', 3.25, 4.50)`); err != nil {
		t.Fatal(err)
	}

	base := syntheticInput()
	var first Revision
	t.Run("persist_exact_values_and_replay_original_revision", func(t *testing.T) {
		var inserted bool
		var err error
		first, inserted, err = store.Append(ctx, base)
		if err != nil || !inserted || first.RecordedAt.IsZero() {
			t.Fatalf("first append: inserted=%v err=%v", inserted, err)
		}
		reordered := cloneInput(base)
		slices.Reverse(reordered.Measurements)
		again, inserted, err := store.Append(ctx, reordered)
		if err != nil || inserted || !reflect.DeepEqual(first, again) {
			t.Fatalf("replay changed stored revision: inserted=%v err=%v", inserted, err)
		}
		read, err := store.Get(ctx, first.RevisionID)
		if err != nil || !reflect.DeepEqual(first, read) {
			t.Fatalf("read did not round trip: %v", err)
		}
		if read.Input.Measurements[1].Percent.Value != "2.00" || read.Input.PublishedAt != "" || read.Input.PublicationEligible {
			t.Fatal("storage invented voting/clock/publication semantics")
		}
	})
	if first.RevisionID == "" {
		t.Fatal("initial append failed; later lineage tests cannot proceed")
	}
	t.Run("rls_hides_review_rows_even_if_a_select_grant_returns", func(t *testing.T) {
		if _, err := pool.Exec(ctx, "GRANT SELECT ON ownership_disclosure_revisions TO "+pgx.Identifier{readerRole}.Sanitize()); err != nil {
			t.Fatal(err)
		}
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if _, err := tx.Exec(ctx, "SET LOCAL ROLE "+pgx.Identifier{readerRole}.Sanitize()); err != nil {
			t.Fatal(err)
		}
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM ownership_disclosure_revisions`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatal("non-owner read immutable review payloads without a policy")
		}
	})

	t.Run("same_identity_changed_values_or_review_metadata_conflicts", func(t *testing.T) {
		for _, edit := range []func(*Input){
			func(in *Input) { in.Measurements[0].Percent.Value = "6.01" },
			func(in *Input) { in.ReviewState = "reviewed" },
			func(in *Input) { in.ReviewReasons = []string{"different supplied reason"} },
			func(in *Input) { in.SupersedesRevisionID = strings.Repeat("a", 64) },
		} {
			changed := cloneInput(base)
			edit(&changed)
			if _, _, err := store.Append(ctx, changed); !errors.Is(err, ErrReplayConflict) {
				t.Fatalf("expected replay conflict, got %v", err)
			}
		}
		history, err := store.List(ctx, first.DisclosureID, 100)
		if err != nil || len(history) != 1 || !reflect.DeepEqual(history[0], first) {
			t.Fatalf("conflict changed original: %v", err)
		}
	})

	t.Run("concurrent_exact_replays_insert_once", func(t *testing.T) {
		in := cloneInput(base)
		in.Source.URL = "https://example.test/notices/concurrent.pdf"
		for i := range in.Measurements {
			in.Measurements[i].Percent.Evidence[0].SourceURL = in.Source.URL
		}
		const workers = 12
		start := make(chan struct{})
		type answer struct {
			revision Revision
			inserted bool
			err      error
		}
		results := make(chan answer, workers)
		for i := 0; i < workers; i++ {
			go func() { <-start; r, ok, err := store.Append(ctx, in); results <- answer{r, ok, err} }()
		}
		close(start)
		insertions := 0
		var original Revision
		for i := 0; i < workers; i++ {
			a := <-results
			if a.err != nil {
				t.Fatal(a.err)
			}
			if a.inserted {
				insertions++
			}
			if i == 0 {
				original = a.revision
			} else if !reflect.DeepEqual(original, a.revision) {
				t.Fatal("concurrent replay returned different content/timestamps")
			}
		}
		if insertions != 1 {
			t.Fatalf("insertions=%d, want1", insertions)
		}
	})

	var second Revision
	t.Run("new_extraction_retains_same_source_history", func(t *testing.T) {
		v2 := cloneInput(base)
		v2.ExtractorVersion = "synthetic-reader.v2"
		v2.SupersedesRevisionID = first.RevisionID
		v2.Measurements[0].Percent.Value = "6.01"
		var inserted bool
		var err error
		second, inserted, err = store.Append(ctx, v2)
		if err != nil || !inserted || second.DisclosureID != first.DisclosureID || second.RevisionID == first.RevisionID {
			t.Fatalf("new extraction: %v", err)
		}
		history, err := store.List(ctx, first.DisclosureID, 100)
		if err != nil || len(history) != 2 {
			t.Fatalf("history len=%d err=%v", len(history), err)
		}
		original, err := store.Get(ctx, first.RevisionID)
		if err != nil || !reflect.DeepEqual(original, first) {
			t.Fatal("re-extraction overwrote original")
		}
	})

	var correction Revision
	t.Run("replaced_source_bytes_require_evidenced_filing_correction", func(t *testing.T) {
		replaced := cloneInput(base)
		replaced.Source.SHA256 = digest([]byte("corrected synthetic source bytes"))
		replaced.SupersedesRevisionID = first.RevisionID
		if _, _, err := store.Append(ctx, replaced); !errors.Is(err, ErrInvalidLineage) {
			t.Fatalf("new source bytes accepted as re-extraction: %v", err)
		}
		replaced.SupersedesRevisionID = ""
		replaced.SupersedesDisclosureID = first.DisclosureID
		replaced.CorrectionEvidence = []Evidence{{SourceURL: replaced.Source.URL, Page: 1, TextSpan: "Synthetic correction explicitly replaces the earlier filing"}}
		replaced.Measurements[0].Percent.Value = "6.02"
		var err error
		var inserted bool
		correction, inserted, err = store.Append(ctx, replaced)
		if err != nil || !inserted || correction.DisclosureID == first.DisclosureID {
			t.Fatalf("filing correction: %v", err)
		}
		original, err := store.Get(ctx, first.RevisionID)
		if err != nil || !reflect.DeepEqual(original, first) {
			t.Fatal("correction rewrote old filing")
		}
	})

	t.Run("missing_predecessors_and_correction_cycles_reject", func(t *testing.T) {
		missing := cloneInput(base)
		missing.ExtractorVersion = "missing-predecessor"
		missing.SupersedesRevisionID = strings.Repeat("b", 64)
		if _, _, err := store.Append(ctx, missing); !errors.Is(err, ErrInvalidLineage) {
			t.Fatalf("missing predecessor: %v", err)
		}
		cycle := cloneInput(base)
		cycle.ExtractorVersion = "synthetic-reader.v3"
		cycle.SupersedesRevisionID = second.RevisionID
		cycle.SupersedesDisclosureID = correction.DisclosureID
		cycle.CorrectionEvidence = []Evidence{{SourceURL: cycle.Source.URL, Page: 1, TextSpan: "Synthetic cyclic correction"}}
		if _, _, err := store.Append(ctx, cycle); !errors.Is(err, ErrInvalidLineage) {
			t.Fatalf("correction cycle: %v", err)
		}
		missing = cloneInput(cycle)
		missing.ExtractorVersion = "missing-correction"
		missing.SupersedesDisclosureID = strings.Repeat("c", 64)
		if _, _, err := store.Append(ctx, missing); !errors.Is(err, ErrInvalidLineage) {
			t.Fatalf("missing corrected filing: %v", err)
		}
	})

	t.Run("concurrent_opposite_corrections_cannot_create_cycle", func(t *testing.T) {
		// Different leading schemas can still resolve to the same table.
		// Their correction writers must take the same graph lock.
		emptySchema := pgx.Identifier{schema + "_empty"}.Sanitize()
		if _, err := admin.Exec(ctx, "CREATE SCHEMA "+emptySchema); err != nil {
			t.Fatal(err)
		}
		defer func() {
			clean, stop := context.WithTimeout(context.Background(), 10*time.Second)
			defer stop()
			if _, err := admin.Exec(clean, "DROP SCHEMA "+emptySchema); err != nil {
				t.Errorf("empty schema cleanup: %v", err)
			}
		}()
		otherConfig := config.Copy()
		otherConfig.ConnConfig.RuntimeParams["search_path"] = emptySchema + "," + quotedSchema + ",pg_catalog"
		otherPool, err := pgxpool.NewWithConfig(ctx, otherConfig)
		if err != nil {
			t.Fatal(err)
		}
		defer otherPool.Close()
		writers := []*Store{store, NewStore(otherPool)}
		inputs := []Input{cloneInput(base), cloneInput(base)}
		originals := make([]Revision, 2)
		for i := range inputs {
			inputs[i].DisclosureSlot = 100 + i
			var err error
			originals[i], _, err = store.Append(ctx, inputs[i])
			if err != nil {
				t.Fatal(err)
			}
		}
		for i := range inputs {
			inputs[i].ExtractorVersion = "opposite-correction.v2"
			inputs[i].SupersedesRevisionID = originals[i].RevisionID
			inputs[i].SupersedesDisclosureID = originals[1-i].DisclosureID
			inputs[i].CorrectionEvidence = []Evidence{{SourceURL: inputs[i].Source.URL, Page: 1, TextSpan: "Synthetic explicit correction"}}
		}
		start := make(chan struct{})
		results := make(chan error, 2)
		var workers sync.WaitGroup
		for i, in := range inputs {
			workers.Add(1)
			go func(writer *Store, in Input) {
				defer workers.Done()
				<-start
				_, _, err := writer.Append(ctx, in)
				results <- err
			}(writers[i], in)
		}
		close(start)
		workers.Wait()
		close(results)
		accepted, rejected := 0, 0
		for err := range results {
			if err == nil {
				accepted++
			} else if errors.Is(err, ErrInvalidLineage) {
				rejected++
			} else {
				t.Fatal(err)
			}
		}
		if accepted != 1 || rejected != 1 {
			t.Fatalf("opposite corrections accepted=%d rejected=%d", accepted, rejected)
		}
	})

	t.Run("database_blocks_history_mutation_and_publication", func(t *testing.T) {
		for _, sql := range []string{
			`UPDATE ownership_disclosure_revisions SET review_state = 'reviewed'`,
			`DELETE FROM ownership_disclosure_revisions`, `TRUNCATE ownership_disclosure_revisions`,
		} {
			_, err := pool.Exec(ctx, sql)
			var pgerr *pgconn.PgError
			if !errors.As(err, &pgerr) || pgerr.Code != "55000" {
				t.Fatalf("mutation was not rejected by immutability trigger: %v", err)
			}
		}
		_, err := pool.Exec(ctx, `INSERT INTO ownership_disclosure_revisions (
			revision_id, disclosure_id, source_url, disclosure_slot, source_sha256, extractor_version,
			extractor_config_sha256, contract_version, document_format, review_state, extraction_completeness,
			publication_eligible, payload_sha256, payload)
			SELECT $1, disclosure_id, source_url, disclosure_slot, source_sha256, 'raw-sql-publication',
			       extractor_config_sha256, contract_version, document_format, review_state, extraction_completeness,
			       true, payload_sha256, payload
			FROM ownership_disclosure_revisions WHERE revision_id = $2`, strings.Repeat("d", 64), first.RevisionID)
		var pgerr *pgconn.PgError
		if !errors.As(err, &pgerr) || pgerr.Code != "23514" {
			t.Fatalf("publication constraint did not reject: %v", err)
		}
	})

	t.Run("stored_payload_integrity_is_checked_on_read", func(t *testing.T) {
		in := cloneInput(base)
		in.ExtractorVersion = "corrupt-hash-fixture"
		r, err := Prepare(in)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(r.Input)
		_, err = pool.Exec(ctx, `INSERT INTO ownership_disclosure_revisions (
			revision_id, disclosure_id, source_url, disclosure_slot, source_sha256, extractor_version,
			extractor_config_sha256, contract_version, document_format, review_state, extraction_completeness,
			payload_sha256, payload)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`, r.RevisionID, r.DisclosureID,
			in.Source.URL, in.DisclosureSlot, in.Source.SHA256, in.ExtractorVersion, in.ExtractorConfigSHA256,
			in.ContractVersion, in.DocumentFormat, in.ReviewState, in.ExtractionCompleteness, strings.Repeat("e", 64), raw)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.Get(ctx, r.RevisionID); !errors.Is(err, ErrStoredRevisionInvalid) {
			t.Fatalf("served tampered payload hash: %v", err)
		}
	})

	t.Run("legacy_voting_rows_remain_unchanged", func(t *testing.T) {
		var count int
		var form, previous, present string
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM substantial_holder_notices`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT form, previous_pct::text, present_pct::text FROM substantial_holder_notices WHERE announcement_url = 'legacy-sentinel'`).Scan(&form, &previous, &present); err != nil {
			t.Fatal(err)
		}
		if count != 1 || form != "604" || previous != "3.2500" || present != "4.5000" {
			t.Fatalf("legacy voting row changed: %d %s %s %s", count, form, previous, present)
		}
	})
}
