package influence

// Upsert precedence and slug immutability, against a real database.
//
// These are the rules that decide whether a senator lands ON the person we
// already publish or BESIDE them, and every one of them is a SQL lookup — so
// they are tested against Postgres, inside a transaction that always rolls
// back. Skipped when no database is configured, like the AEC resolve suite.

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
)

type senatorFixture struct {
	t   *testing.T
	ctx context.Context
	tx  pgx.Tx
}

func newSenatorFixture(t *testing.T) *senatorFixture {
	t.Helper()
	ctx := context.Background()
	pool := aecTestPool(t)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	t.Cleanup(func() { _ = tx.Rollback(ctx) })
	return &senatorFixture{t: t, ctx: ctx, tx: tx}
}

// existing inserts a politician the register load would have minted. Surnames
// are invented so they cannot collide with the real rows a development database
// already holds.
func (f *senatorFixture) existing(personKey, surname, given, slug, phid string) string {
	f.t.Helper()
	var id string
	if err := f.tx.QueryRow(f.ctx, `
		INSERT INTO politicians (person_key, surname, given_names, display_name, slug, aph_phid)
		VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text`,
		personKey, surname, given, given+" "+surname, slug, phid).Scan(&id); err != nil {
		f.t.Fatalf("insert %s: %v", slug, err)
	}
	return id
}

func (f *senatorFixture) upsert(id senatorIdentity) *senatorUpsertStats {
	f.t.Helper()
	stats := &senatorUpsertStats{}
	if err := upsertSenator(f.ctx, f.tx, id, stats); err != nil {
		f.t.Fatalf("upsert %s: %v", id.DisplayName, err)
	}
	return stats
}

func (f *senatorFixture) row(personKeyOrPHID string) (slug, personKey, phid string, found bool) {
	f.t.Helper()
	err := f.tx.QueryRow(f.ctx, `
		SELECT slug, person_key, btrim(aph_phid) FROM politicians
		WHERE person_key = $1 OR btrim(aph_phid) = $1`, personKeyOrPHID).Scan(&slug, &personKey, &phid)
	if err == pgx.ErrNoRows {
		return "", "", "", false
	}
	if err != nil {
		f.t.Fatalf("read %s: %v", personKeyOrPHID, err)
	}
	return slug, personKey, phid, true
}

func testSenator(phid, surname, formal, preferred string, parliaments ...int) senatorIdentity {
	h := handbookIndividual{
		PHID: phid, FamilyName: surname, GivenName: formal, PreferredName: "(" + preferred + ")",
		SenateState: "Tasmania", MPorSenator: []string{"Senator"},
		RepresentedParliaments: parliaments,
	}
	if preferred == "" {
		h.PreferredName = ""
	}
	for _, p := range parliaments {
		span, ok := parliamentSpan(p)
		if !ok {
			continue
		}
		h.PartyParliamentaryService = append(h.PartyParliamentaryService, handbookServiceInterval{
			RoSType:   "Parliamentary Service",
			DateStart: span.From.Format("2006-01-02"),
			DateEnd:   span.From.AddDate(0, 1, 0).Format("2006-01-02"),
		})
	}
	id, ok := buildSenatorIdentity(h)
	if !ok {
		panic("fixture identity withheld")
	}
	return id
}

// PHID FIRST. A dual-chamber member already in the table from their House
// service gains Senate terms rather than a second row — even when their
// person_key does not match, which is the Ben Small case (SMALL|BEN in the
// register, SMALL|BENJAMIN in the Handbook).
func TestUpsertPrefersPHIDOverEveryNameKey(t *testing.T) {
	f := newSenatorFixture(t)
	existingID := f.existing("ZZTESTSMALL|BEN", "Zztestsmall", "Ben", "zztest-ben-small", "ZZPHID1")

	id := testSenator("ZZPHID1", "ZZTESTSMALL", "Benjamin", "Ben", 47)
	stats := f.upsert(id)

	if stats.Minted != 0 || stats.MatchedPHID != 1 {
		t.Fatalf("minted %d, matched-by-phid %d; want 0 and 1", stats.Minted, stats.MatchedPHID)
	}
	var terms int
	if err := f.tx.QueryRow(f.ctx, `
		SELECT count(*) FROM politician_terms WHERE politician_id = $1 AND chamber = 'senate'`,
		existingID).Scan(&terms); err != nil {
		t.Fatal(err)
	}
	if terms != 1 {
		t.Fatalf("%d senate terms on the existing row, want 1", terms)
	}
	// And the slug they already publish under is untouched.
	slug, _, _, _ := f.row("ZZPHID1")
	if slug != "zztest-ben-small" {
		t.Errorf("slug became %q — slugs are minted ONCE", slug)
	}
}

// THEN person_key. The rows that predate register-handbook carry no PHID; they
// must be UPDATED into one, never duplicated. This is Ananda-Rajah and
// Henderson, exactly.
func TestUpsertFallsBackToPersonKeyAndFillsThePHID(t *testing.T) {
	f := newSenatorFixture(t)
	f.existing("ZZTESTHENDER|SARAH", "Zztesthender", "Sarah", "zztest-sarah-hender", "")

	stats := f.upsert(testSenator("ZZPHID2", "ZZTESTHENDER", "Sarah", "", 47))
	if stats.Minted != 0 || stats.MatchedKey != 1 {
		t.Fatalf("minted %d, matched-by-person_key %d; want 0 and 1", stats.Minted, stats.MatchedKey)
	}
	slug, _, phid, _ := f.row("ZZTESTHENDER|SARAH")
	if phid != "ZZPHID2" {
		t.Errorf("phid = %q, want it filled in", phid)
	}
	if slug != "zztest-sarah-hender" {
		t.Errorf("slug became %q", slug)
	}
}

// THEN the preferred-name key, because person_key cannot collapse Matt against
// Matthew on its own — and that is how the 28 published duplicates were made.
func TestUpsertFallsBackToThePreferredNameKey(t *testing.T) {
	f := newSenatorFixture(t)
	f.existing("ZZTESTCANAV|MATT", "Zztestcanav", "Matt", "zztest-matt-canav", "")

	stats := f.upsert(testSenator("ZZPHID3", "ZZTESTCANAV", "Matthew", "Matt", 47))
	if stats.Minted != 0 || stats.MatchedPreferred != 1 {
		t.Fatalf("minted %d, matched-by-preferred %d; want 0 and 1", stats.Minted, stats.MatchedPreferred)
	}
	var rows int
	if err := f.tx.QueryRow(f.ctx, `
		SELECT count(*) FROM politicians WHERE surname = 'Zztestcanav'`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("%d rows for one man, want 1", rows)
	}
}

// A PHID held by TWO rows is a DISPUTED identity. 28 of them exist today
// (chris-bowen/christopher-bowen and the rest), and picking one is a coin flip
// re-tossed on every run. It writes nothing at all — including no third row.
func TestUpsertWithholdsOnADisputedPHID(t *testing.T) {
	f := newSenatorFixture(t)
	f.existing("ZZTESTDUP|MATT", "Zztestdup", "Matt", "zztest-matt-dup", "ZZPHID4")
	f.existing("ZZTESTDUP|MATTHEW", "Zztestdup", "Matthew", "zztest-matthew-dup", "ZZPHID4")

	stats := f.upsert(testSenator("ZZPHID4", "ZZTESTDUP", "Matthew", "Matt", 47))
	if stats.Conflicts != 1 || stats.Minted != 0 || stats.Terms != 0 {
		t.Fatalf("conflicts %d, minted %d, terms %d; want 1, 0, 0", stats.Conflicts, stats.Minted, stats.Terms)
	}
	var rows int
	if err := f.tx.QueryRow(f.ctx, `
		SELECT count(*) FROM politicians WHERE surname = 'Zztestdup'`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 2 {
		t.Fatalf("%d rows, want the 2 that were already there and no third", rows)
	}
}

// A person_key match onto a row that already holds a DIFFERENT PHID is two
// people colliding on a name. It withholds rather than moving a stranger's
// career onto a named person.
func TestUpsertWithholdsWhenTheMatchedRowHoldsAnotherPHID(t *testing.T) {
	f := newSenatorFixture(t)
	f.existing("ZZTESTCOLL|JOHN", "Zztestcoll", "John", "zztest-john-coll", "ZZOTHER")

	stats := f.upsert(testSenator("ZZPHID5", "ZZTESTCOLL", "John", "", 47))
	if stats.Conflicts != 1 || stats.Terms != 0 {
		t.Fatalf("conflicts %d, terms %d; want 1 and 0", stats.Conflicts, stats.Terms)
	}
}

// Minting is idempotent, and the slug survives a second run unchanged. Slugs
// reach OG images, the sitemap and editorial cross-links.
func TestMintedSlugIsNeverReMinted(t *testing.T) {
	f := newSenatorFixture(t)
	id := testSenator("ZZPHID6", "ZZTESTFRESH", "Penelope", "Penny", 47, 48)

	first := f.upsert(id)
	if first.Minted != 1 || first.Terms != 2 {
		t.Fatalf("first run minted %d with %d terms, want 1 and 2", first.Minted, first.Terms)
	}
	slug, personKey, _, _ := f.row("ZZPHID6")
	if slug != "penny-zztestfresh" {
		t.Fatalf("slug = %q, want the PREFERRED name", slug)
	}
	if personKey != "ZZTESTFRESH|PENELOPE" {
		t.Fatalf("person_key = %q, want the FORMAL name", personKey)
	}

	second := f.upsert(id)
	if second.Minted != 0 || second.MatchedPHID != 1 {
		t.Fatalf("second run minted %d, want 0", second.Minted)
	}
	slugAgain, _, _, _ := f.row("ZZPHID6")
	if slugAgain != slug {
		t.Fatalf("slug moved from %q to %q on a re-run", slug, slugAgain)
	}

	// The preferred-name alias is what lets a later register load reach this row
	// instead of minting a second one for "Penny".
	var aliasOwner string
	if err := f.tx.QueryRow(f.ctx, `
		SELECT p.slug FROM politician_aliases a JOIN politicians p ON p.id = a.politician_id
		WHERE a.alias_key = 'ZZTESTFRESH|PENNY'`).Scan(&aliasOwner); err != nil {
		t.Fatalf("preferred-name alias not seeded: %v", err)
	}
	if aliasOwner != slug {
		t.Errorf("alias points at %q, want %q", aliasOwner, slug)
	}
}

// resolvePolitician consults that alias. Without this the whole seeding exercise
// is inert: a Senate register volume writing "Penny Zztestfresh" would mint a
// second identity beside the one minted here.
func TestResolvePoliticianFindsAPersonThroughTheirAlias(t *testing.T) {
	f := newSenatorFixture(t)
	f.upsert(testSenator("ZZPHID7", "ZZTESTALIAS", "Penelope", "Penny", 48))
	mintedSlug, _, _, _ := f.row("ZZPHID7")

	// The register load's own identity parse yields the PREFERRED key.
	id := parseMemberHint("Zztestalias, Ms Penny, Member for Nowhere, TAS")
	if id.PersonKey != "ZZTESTALIAS|PENNY" {
		t.Fatalf("fixture parse gave %q", id.PersonKey)
	}
	got, err := resolvePolitician(f.ctx, f.tx, id, "TAS", "Nowhere", "https://example.test", 48, "house")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}

	var slug string
	if err := f.tx.QueryRow(f.ctx, `SELECT slug FROM politicians WHERE id = $1`, got).Scan(&slug); err != nil {
		t.Fatal(err)
	}
	if slug != mintedSlug {
		t.Fatalf("resolved to %q, want the existing %q — a second identity was forked", slug, mintedSlug)
	}
}
