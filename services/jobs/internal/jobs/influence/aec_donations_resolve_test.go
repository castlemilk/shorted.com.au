package influence

// Resolution rules are SQL, so they are tested against a real database. Every
// case runs inside a transaction that is ALWAYS rolled back, so the suite can
// point at a development database without disturbing it.
//
// Skipped unless AEC_TEST_DATABASE_URL or DATABASE_URL is set, so `go test ./...`
// stays green on a machine with no Postgres.
//
// The withhold cases matter more than the hits. A resolver that matches
// generously is not a better resolver — it is one that will eventually attribute
// someone else's money to a named living person.

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func aecTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("AEC_TEST_DATABASE_URL")
	if url == "" {
		url = os.Getenv("DATABASE_URL")
	}
	if url == "" {
		t.Skip("set AEC_TEST_DATABASE_URL or DATABASE_URL to run the resolution tests")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Skipf("connect: %v", err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		pool.Close()
		t.Skipf("ping: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// aecResolveFixture opens a rolled-back transaction with an empty aec_* snapshot
// and the given politicians/terms in place.
type aecResolveFixture struct {
	t   *testing.T
	ctx context.Context
	tx  pgx.Tx
}

func newAECResolveFixture(t *testing.T) *aecResolveFixture {
	t.Helper()
	ctx := context.Background()
	pool := aecTestPool(t)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	t.Cleanup(func() { _ = tx.Rollback(ctx) })

	if _, err := tx.Exec(ctx, `
		TRUNCATE aec_party_returns, aec_receipts, aec_donations_made,
		         aec_mp_returns, aec_candidate_donations, aec_candidate_returns`); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	return &aecResolveFixture{t: t, ctx: ctx, tx: tx}
}

// politician inserts a fixture politician and returns its id. Surnames in these
// tests are invented so they cannot collide with the 300-odd real rows a
// development database already holds.
func (f *aecResolveFixture) politician(surname, given, slug string) string {
	f.t.Helper()
	var id string
	err := f.tx.QueryRow(f.ctx, `
		INSERT INTO politicians (person_key, surname, given_names, display_name, slug)
		VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		// person_key is keyed off the SLUG, not surname|given: two fixture rows
		// deliberately share a surname and given name to exercise ambiguity, and
		// person_key is UNIQUE.
		slug, surname, given, given+" "+surname, slug).Scan(&id)
	if err != nil {
		f.t.Fatalf("insert politician %s: %v", slug, err)
	}
	return id
}

func (f *aecResolveFixture) term(politicianID string, parliament int, division, party string) {
	f.t.Helper()
	if _, err := f.tx.Exec(f.ctx, `
		INSERT INTO politician_terms (politician_id, parliament, chamber, division, party)
		VALUES ($1, $2, 'house', $3, $4)`, politicianID, parliament, division, party); err != nil {
		f.t.Fatalf("insert term: %v", err)
	}
}

func (f *aecResolveFixture) mpReturn(memberName string) {
	f.t.Helper()
	given, surname := splitAECMemberName(memberName)
	if _, err := f.tx.Exec(f.ctx, `
		INSERT INTO aec_mp_returns (financial_year, financial_year_end, return_type, chamber,
			member_name, member_name_norm, surname, given_names, source_url)
		VALUES ('2024-25', 2025, 'Member of House of Representatives Return', 'house',
			$1, $2, $3, $4, 'https://transparency.aec.gov.au/Download/AllAnnualData')`,
		memberName, normalizeAECEntityName(stripAECHonorifics(memberName)), surname, given); err != nil {
		f.t.Fatalf("insert mp return %q: %v", memberName, err)
	}
}

func (f *aecResolveFixture) candidateReturn(event string, parliament *int, returnType, name, electorate, party string) {
	f.t.Helper()
	given, surname := splitAECCandidateName(name)
	var p any
	if parliament != nil {
		p = *parliament
	}
	if _, err := f.tx.Exec(f.ctx, `
		INSERT INTO aec_candidate_returns (event, event_parliament, return_type, candidate_name,
			surname, given_names, party_name, electorate_name, source_url)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'https://transparency.aec.gov.au/Download/AllElectionsData')`,
		event, p, returnType, name, surname, given, party, electorate); err != nil {
		f.t.Fatalf("insert candidate return %q: %v", name, err)
	}
}

// alias files an ENTITY-LAYER curated decision: a normalised name, the key
// space company donors, party branches and MP-return member names live in.
func (f *aecResolveFixture) alias(aliasNorm, kind string, politicianID any) {
	f.t.Helper()
	f.aliasInLayer(aliasNorm, kind, "entity_name", politicianID)
}

// candidateAlias files a CANDIDATE-LAYER decision, keyed 'SURNAME|GIVEN NAMES'
// exactly as the election files split a candidate name.
func (f *aecResolveFixture) candidateAlias(surname, given, kind string, politicianID any) {
	f.t.Helper()
	f.aliasInLayer(strings.ToUpper(surname)+"|"+strings.ToUpper(given), kind, "candidate_name", politicianID)
}

func (f *aecResolveFixture) aliasInLayer(aliasNorm, kind, layer string, politicianID any) {
	f.t.Helper()
	if _, err := f.tx.Exec(f.ctx, `
		INSERT INTO aec_entity_aliases (alias_norm, target_kind, target_layer, politician_id, curated_by, note)
		VALUES ($1, $2, $3, $4, 'aec_donations_resolve_test', 'fixture')`,
		aliasNorm, kind, layer, politicianID); err != nil {
		f.t.Fatalf("insert alias %q (%s): %v", aliasNorm, layer, err)
	}
}

func (f *aecResolveFixture) resolve() *aecResolutionCounts {
	f.t.Helper()
	counts, err := resolveAECDonations(f.ctx, f.tx)
	if err != nil {
		f.t.Fatalf("resolve: %v", err)
	}
	return counts
}

// mpSlug returns the slug an MP return resolved to, or "" when withheld.
func (f *aecResolveFixture) mpSlug(memberName string) string {
	f.t.Helper()
	var slug *string
	err := f.tx.QueryRow(f.ctx, `
		SELECT p.slug FROM aec_mp_returns r
		LEFT JOIN politicians p ON p.id = r.politician_id
		WHERE r.member_name = $1`, memberName).Scan(&slug)
	if err != nil {
		f.t.Fatalf("read mp return %q: %v", memberName, err)
	}
	if slug == nil {
		return ""
	}
	return *slug
}

func (f *aecResolveFixture) candidateSlug(name string) string {
	f.t.Helper()
	var slug *string
	err := f.tx.QueryRow(f.ctx, `
		SELECT p.slug FROM aec_candidate_returns c
		LEFT JOIN politicians p ON p.id = c.politician_id
		WHERE c.candidate_name = $1`, name).Scan(&slug)
	if err != nil {
		f.t.Fatalf("read candidate return %q: %v", name, err)
	}
	if slug == nil {
		return ""
	}
	return *slug
}

// ---------------------------------------------------------------------------
// MP returns: honorific-stripped surname + given name.
// ---------------------------------------------------------------------------

func TestResolveMPReturnBySurnameAndGivenName(t *testing.T) {
	f := newAECResolveFixture(t)
	f.politician("Quilberro", "Monique", "monique-quilberro")
	f.mpReturn("Dr Monique Quilberro MP")

	counts := f.resolve()
	if counts.MPResolvedExact != 1 {
		t.Fatalf("resolved %d, want 1", counts.MPResolvedExact)
	}
	if got := f.mpSlug("Dr Monique Quilberro MP"); got != "monique-quilberro" {
		t.Errorf("slug = %q, want monique-quilberro", got)
	}
}

// The Monique Ryan / Joanne Ryan case: a shared surname must NOT resolve on the
// surname alone, and the given name must pick the right one of the two.
func TestResolveMPReturnDisambiguatesSharedSurname(t *testing.T) {
	f := newAECResolveFixture(t)
	f.politician("Quilberro", "Monique", "monique-quilberro")
	f.politician("Quilberro", "Joanne", "joanne-quilberro")
	f.mpReturn("Dr Monique Quilberro MP")

	f.resolve()
	if got := f.mpSlug("Dr Monique Quilberro MP"); got != "monique-quilberro" {
		t.Errorf("slug = %q, want monique-quilberro (never the namesake)", got)
	}
}

// Two people who share BOTH surname and first given name are indistinguishable
// from this data. The return must resolve to NOBODY.
func TestResolveMPReturnWithholdsOnAmbiguity(t *testing.T) {
	f := newAECResolveFixture(t)
	f.politician("Quilberro", "Alex", "alex-quilberro")
	f.politician("Quilberro", "Alex", "alex-quilberro-2")
	f.mpReturn("Mr Alex Quilberro MP")

	counts := f.resolve()
	if counts.MPResolvedExact != 0 {
		t.Fatalf("resolved %d ambiguous returns, want 0", counts.MPResolvedExact)
	}
	if got := f.mpSlug("Mr Alex Quilberro MP"); got != "" {
		t.Errorf("ambiguous return resolved to %q, want withheld", got)
	}
	if counts.MPWithheldAmbig != 1 {
		t.Errorf("withheld-ambiguous count = %d, want 1", counts.MPWithheldAmbig)
	}
}

// A name that reduces to a bare surname has nothing to disambiguate on. This is
// the "Anthony Smith" matched to Dean Smith failure, and it must be impossible.
func TestResolveMPReturnWithholdsBareSurname(t *testing.T) {
	f := newAECResolveFixture(t)
	f.politician("Quilberro", "Alex", "alex-quilberro")
	f.mpReturn("Senator Quilberro")

	counts := f.resolve()
	if got := f.mpSlug("Senator Quilberro"); got != "" {
		t.Errorf("bare surname resolved to %q, want withheld", got)
	}
	if counts.MPWithheldNoGiven != 1 {
		t.Errorf("withheld-no-given count = %d, want 1", counts.MPWithheldNoGiven)
	}
}

// A member the AEC names differently from the register (Antonio vs Tony Zappia,
// live in the real corpus) is exactly what the curated table is for.
func TestResolveMPReturnByCuratedAlias(t *testing.T) {
	f := newAECResolveFixture(t)
	id := f.politician("Zapperino", "Tony", "tony-zapperino")
	f.mpReturn("Mr Antonio Zapperino MP")
	f.alias(normalizeAECEntityName("Antonio Zapperino"), "politician", id)

	counts := f.resolve()
	if counts.MPResolvedAlias != 1 || counts.MPResolvedExact != 0 {
		t.Fatalf("alias=%d exact=%d, want 1 and 0", counts.MPResolvedAlias, counts.MPResolvedExact)
	}
	if got := f.mpSlug("Mr Antonio Zapperino MP"); got != "tony-zapperino" {
		t.Errorf("slug = %q, want tony-zapperino", got)
	}
}

// An 'ignore' alias is the ONLY override of the automatic layer, and it must
// beat an otherwise-perfect exact match.
func TestResolveMPReturnIgnoreAliasSuppressesExactMatch(t *testing.T) {
	f := newAECResolveFixture(t)
	f.politician("Quilberro", "Monique", "monique-quilberro")
	f.mpReturn("Dr Monique Quilberro MP")
	f.alias(normalizeAECEntityName("Monique Quilberro"), "ignore", nil)

	counts := f.resolve()
	if counts.MPResolvedExact != 0 {
		t.Fatalf("resolved %d despite an ignore alias, want 0", counts.MPResolvedExact)
	}
	if got := f.mpSlug("Dr Monique Quilberro MP"); got != "" {
		t.Errorf("suppressed return resolved to %q, want withheld", got)
	}
}

// ---------------------------------------------------------------------------
// Candidate returns: division + surname within the parliament the event elected.
// ---------------------------------------------------------------------------

func parliamentPtr(n int) *int { return &n }

func TestResolveCandidateReturnByDivisionAndSurname(t *testing.T) {
	f := newAECResolveFixture(t)
	id := f.politician("Zzyzxwell", "Peter", "peter-zzyzxwell")
	f.term(id, 47, "Fictionia", "Liberal Party of Australia")
	f.candidateReturn("2022 Federal election", parliamentPtr(47), "Candidate",
		"ZZYZXWELL, Peter Craig", "Fictionia", "Liberal Party of Australia")

	counts := f.resolve()
	if counts.CandidateResolvedExact != 1 {
		t.Fatalf("resolved %d, want 1", counts.CandidateResolvedExact)
	}
	if got := f.candidateSlug("ZZYZXWELL, Peter Craig"); got != "peter-zzyzxwell" {
		t.Errorf("slug = %q, want peter-zzyzxwell", got)
	}
}

// The Dutton-in-2025 case: a candidate who did not go on to hold the seat has no
// term in that parliament, so the return names them verbatim and resolves to
// nobody. Losing is not a resolution failure.
func TestResolveCandidateReturnWithholdsWhenTheSeatWasNotHeld(t *testing.T) {
	f := newAECResolveFixture(t)
	id := f.politician("Zzyzxwell", "Peter", "peter-zzyzxwell")
	f.term(id, 47, "Fictionia", "Liberal Party of Australia")
	// Same person, next election, but no 48th-parliament term.
	f.candidateReturn("2025 Federal Election", parliamentPtr(48), "Candidate",
		"ZZYZXWELL, Peter Craig", "Fictionia", "Liberal Party of Australia")

	counts := f.resolve()
	if counts.CandidateResolvedExact != 0 {
		t.Fatalf("resolved %d, want 0", counts.CandidateResolvedExact)
	}
	if got := f.candidateSlug("ZZYZXWELL, Peter Craig"); got != "" {
		t.Errorf("resolved to %q, want withheld", got)
	}
	if counts.CandidateWithheldNoSeat != 1 {
		t.Errorf("withheld-no-seat = %d, want 1", counts.CandidateWithheldNoSeat)
	}
}

// A by-election carries no mapped parliament, so it cannot be resolved without
// guessing which term it falls in.
func TestResolveCandidateReturnWithholdsByElection(t *testing.T) {
	f := newAECResolveFixture(t)
	id := f.politician("Zzyzxwell", "Kerryn", "kerryn-zzyzxwell")
	f.term(id, 45, "Fictionia", "Independent")
	f.candidateReturn("Fictionia by-election", nil, "Candidate",
		"ZZYZXWELL, Kerryn", "Fictionia", "Independent")

	counts := f.resolve()
	if got := f.candidateSlug("ZZYZXWELL, Kerryn"); got != "" {
		t.Errorf("by-election resolved to %q, want withheld", got)
	}
	if counts.CandidateWithheldNoEvent != 1 {
		t.Errorf("withheld-no-event = %d, want 1", counts.CandidateWithheldNoEvent)
	}
}

// A Senate Group's "electorate" is a STATE. It matches no division and must
// resolve to nobody without needing a special case.
func TestResolveCandidateReturnWithholdsSenateGroup(t *testing.T) {
	f := newAECResolveFixture(t)
	id := f.politician("Zzyzxwell", "Sam", "sam-zzyzxwell")
	f.term(id, 48, "Fictionia", "Australian Labor Party")
	f.candidateReturn("2025 Federal Election", parliamentPtr(48), "Senate Group",
		"ZZYZXWELL, Sam", "Victoria", "Australian Labor Party")

	f.resolve()
	if got := f.candidateSlug("ZZYZXWELL, Sam"); got != "" {
		t.Errorf("senate group resolved to %q, want withheld", got)
	}
}

// Two people of the same surname holding one division in one parliament (a
// by-election succession, or an unmerged duplicate in the register — the real
// corpus contains one of the latter) must withhold.
func TestResolveCandidateReturnWithholdsOnAmbiguity(t *testing.T) {
	f := newAECResolveFixture(t)
	// Both hold the seat, both carry the candidate's given name and both carry
	// the candidate's party, so nothing in the rule can separate them. That is
	// the shape ambiguity actually has now that given names and party are part
	// of the match — a return neither guard can attribute must go to nobody.
	a := f.politician("Zzyzxwell", "Julie", "julie-zzyzxwell")
	b := f.politician("Zzyzxwell", "Julie", "julie-zzyzxwell-2")
	f.term(a, 48, "Fictionia", "Australian Labor Party")
	f.term(b, 48, "Fictionia", "Australian Labor Party")
	f.candidateReturn("2025 Federal Election", parliamentPtr(48), "Candidate",
		"ZZYZXWELL, Julie Ann", "Fictionia", "Australian Labor Party")

	counts := f.resolve()
	if counts.CandidateResolvedExact != 0 {
		t.Fatalf("resolved %d ambiguous returns, want 0", counts.CandidateResolvedExact)
	}
	if got := f.candidateSlug("ZZYZXWELL, Julie Ann"); got != "" {
		t.Errorf("ambiguous return resolved to %q, want withheld", got)
	}
	if counts.CandidateWithheldAmbig != 1 {
		t.Errorf("withheld-ambiguous = %d, want 1", counts.CandidateWithheldAmbig)
	}
}

// A candidate whose given name matches NOBODY holding the seat is withheld for a
// different reason than an ambiguous one, and the two must not be conflated: one
// says the resolver could not choose, the other says the seat's member is
// someone else.
func TestResolveCandidateReturnAttributesADifferentPersonSeparately(t *testing.T) {
	f := newAECResolveFixture(t)
	id := f.politician("Zzyzxwell", "Julie", "julie-zzyzxwell")
	f.term(id, 48, "Fictionia", "Australian Labor Party")
	f.candidateReturn("2025 Federal Election", parliamentPtr(48), "Candidate",
		"ZZYZXWELL, Bartholomew", "Fictionia", "Liberal Party of Australia (Victorian Division)")

	counts := f.resolve()
	if got := f.candidateSlug("ZZYZXWELL, Bartholomew"); got != "" {
		t.Errorf("resolved to %q, want withheld", got)
	}
	if counts.CandidateWithheldNameParty != 1 {
		t.Errorf("withheld-different-person = %d, want 1", counts.CandidateWithheldNameParty)
	}
	if counts.CandidateWithheldAmbig != 0 {
		t.Errorf("a namesake was counted as ambiguous (%d); the reasons must stay distinct",
			counts.CandidateWithheldAmbig)
	}
}

// ---------------------------------------------------------------------------
// The losing namesake: the misattribution this layer exists to prevent.
// ---------------------------------------------------------------------------

// termHolder returns the politician id holding a division in a parliament, or ""
// when this database does not hold that term.
func (f *aecResolveFixture) termHolder(parliament int, division, slug string) string {
	f.t.Helper()
	var id *string
	err := f.tx.QueryRow(f.ctx, `
		SELECT p.id::text FROM politician_terms t
		JOIN politicians p ON p.id = t.politician_id AND p.merged_into_id IS NULL
		WHERE t.parliament = $1 AND upper(t.division) = upper($2) AND p.slug = $3`,
		parliament, division, slug).Scan(&id)
	if err != nil || id == nil {
		return ""
	}
	return *id
}

// BOTH LIVE REPRODUCTIONS, pinned against the real register rows.
//
// Division + surname alone also fits the candidate who LOST that division to
// someone of the same surname. In the 2025 corpus that resolved 'RISHWORTH,
// James Philip' (Liberal, Kingston) to Amanda Rishworth (ALP) and 'LE, Nguyen-Tu'
// (ALP, Fowler) to Dai Le (IND) — another person's declared money on a named
// living person's page. The given-name and party guards each reject both rows on
// their own, and the winners in the same division must still resolve, or the fix
// would be a coverage cut wearing a correctness badge.
func TestResolveCandidateReturnWithholdsALosingNamesake(t *testing.T) {
	f := newAECResolveFixture(t)
	if f.termHolder(48, "Kingston", "amanda-rishworth") == "" ||
		f.termHolder(48, "Fowler", "dai-le") == "" {
		t.Skip("this database does not hold the 48th-parliament Kingston and Fowler terms")
	}

	// Verbatim from AllElectionsData, including the branch-name party labels.
	f.candidateReturn("2025 Federal Election", parliamentPtr(48), "Candidate",
		"RISHWORTH, James Philip", "Kingston", "Liberal Party of Australia (S.A. Division)")
	f.candidateReturn("2025 Federal Election", parliamentPtr(48), "Candidate",
		"RISHWORTH, Amanda Louise", "Kingston", "Australian Labor Party (South Australian Branch)")
	f.candidateReturn("2025 Federal Election", parliamentPtr(48), "Candidate",
		"LE, Nguyen-Tu", "Fowler", "Australian Labor Party (N.S.W. Branch)")
	f.candidateReturn("2025 Federal Election", parliamentPtr(48), "Candidate",
		"LE, Dai Trang", "Fowler", "Independent")

	counts := f.resolve()

	if got := f.candidateSlug("RISHWORTH, James Philip"); got != "" {
		t.Errorf("a losing candidate resolved to %q; his return names him, not the member for Kingston", got)
	}
	if got := f.candidateSlug("LE, Nguyen-Tu"); got != "" {
		t.Errorf("a losing candidate resolved to %q; her return names her, not the member for Fowler", got)
	}
	// The seat's actual member, same surname, same division, same event.
	if got := f.candidateSlug("RISHWORTH, Amanda Louise"); got != "amanda-rishworth" {
		t.Errorf("the member for Kingston resolved to %q, want amanda-rishworth", got)
	}
	if got := f.candidateSlug("LE, Dai Trang"); got != "dai-le" {
		t.Errorf("the member for Fowler resolved to %q, want dai-le", got)
	}
	// Withholding must be ATTRIBUTED, not silent: an operator reading the run
	// needs to see that two returns were withheld because the seat's member is a
	// different person, rather than watching a total quietly shrink.
	if counts.CandidateWithheldNameParty != 2 {
		t.Errorf("withheld-different-person count = %d, want 2", counts.CandidateWithheldNameParty)
	}
}

// A candidate the register records by a middle name ('Dugald Milton Dick' filed
// as 'Milton') still agrees: token equality is exact in both directions.
func TestResolveCandidateReturnAcceptsAGivenNameRecordedAsAMiddleName(t *testing.T) {
	f := newAECResolveFixture(t)
	id := f.politician("Zzyzxwell", "Milton", "milton-zzyzxwell")
	f.term(id, 47, "Fictionia", "Australian Labor Party")
	f.candidateReturn("2022 Federal election", parliamentPtr(47), "Candidate",
		"ZZYZXWELL, Dugald Milton", "Fictionia", "Australian Labor Party (Victorian Branch)")

	f.resolve()
	if got := f.candidateSlug("ZZYZXWELL, Dugald Milton"); got != "milton-zzyzxwell" {
		t.Errorf("slug = %q, want milton-zzyzxwell", got)
	}
}

// A diminutive is NOT a match. This is a deliberate coverage loss — the remedy
// is a curated alias, a human decision on the record, not a rule loose enough to
// also admit a namesake.
func TestResolveCandidateReturnWithholdsADiminutive(t *testing.T) {
	f := newAECResolveFixture(t)
	id := f.politician("Zzyzxwell", "Tony", "tony-zzyzxwell")
	f.term(id, 47, "Fictionia", "Liberal")
	f.candidateReturn("2022 Federal election", parliamentPtr(47), "Candidate",
		"ZZYZXWELL, Anthony John", "Fictionia", "Liberal Party of Australia (Victorian Division)")

	f.resolve()
	if got := f.candidateSlug("ZZYZXWELL, Anthony John"); got != "" {
		t.Errorf("a diminutive resolved to %q by rule; it must go through a curated alias", got)
	}

	// And the curated alias is a working remedy, not a theoretical one.
	f.candidateAlias("ZZYZXWELL", "Anthony John", "politician", id)
	counts := f.resolve()
	if counts.CandidateResolvedAlias != 1 {
		t.Fatalf("alias resolutions = %d, want 1", counts.CandidateResolvedAlias)
	}
	if got := f.candidateSlug("ZZYZXWELL, Anthony John"); got != "tony-zzyzxwell" {
		t.Errorf("slug = %q, want tony-zzyzxwell", got)
	}
}

// The party guard withholds on a contradiction and NEVER on a branch-name
// mismatch: 'Liberal Party of Australia (S.A. Division)' and 'Liberal' are not
// equal strings and must not be treated as a disagreement.
func TestResolveCandidateReturnToleratesABranchNameAgainstAFederalParty(t *testing.T) {
	f := newAECResolveFixture(t)
	id := f.politician("Zzyzxwell", "Peter", "peter-zzyzxwell")
	f.term(id, 47, "Fictionia", "Liberal")
	f.candidateReturn("2022 Federal election", parliamentPtr(47), "Candidate",
		"ZZYZXWELL, Peter Craig", "Fictionia", "Liberal Party of Australia (S.A. Division)")

	f.resolve()
	if got := f.candidateSlug("ZZYZXWELL, Peter Craig"); got != "peter-zzyzxwell" {
		t.Errorf("slug = %q; a branch name is not a contradiction of the federal party", got)
	}
}

// Rule 3b breaks a tie with an exact party match. It must honour the SAME
// 'ignore' suppression rule 3 does: a curator who suppresses a wrong match and
// watches the tiebreaker re-make it has no remedy at all.
// tiebreakerFixture builds the one shape rule 3b exists for: two same-surname,
// same-given-name members of one division in one parliament, only one of whom
// carries the candidate's party exactly. Rule 3 cannot choose between them (an
// empty term party contradicts nothing), so the tiebreaker is what resolves it.
func tiebreakerFixture(t *testing.T) *aecResolveFixture {
	t.Helper()
	f := newAECResolveFixture(t)
	a := f.politician("Zzyzxwell", "Robin", "robin-zzyzxwell")
	b := f.politician("Zzyzxwell", "Robin", "robin-zzyzxwell-2")
	f.term(a, 48, "Fictionia", "Australian Labor Party")
	f.term(b, 48, "Fictionia", "")
	f.candidateReturn("2025 Federal Election", parliamentPtr(48), "Candidate",
		"ZZYZXWELL, Robin", "Fictionia", "Australian Labor Party")
	return f
}

func TestResolveCandidateReturnTiebreakerResolvesAnAmbiguousPair(t *testing.T) {
	f := tiebreakerFixture(t)

	counts := f.resolve()
	if got := f.candidateSlug("ZZYZXWELL, Robin"); got != "robin-zzyzxwell" {
		t.Fatalf("the tiebreaker did not resolve the ambiguous pair: slug = %q", got)
	}
	if counts.CandidateResolvedExact != 1 {
		t.Fatalf("resolved %d, want 1 (via the party tiebreaker)", counts.CandidateResolvedExact)
	}
}

// Rule 3b breaks a tie with an exact party match. It must honour the SAME
// 'ignore' suppression rule 3 does: a curator who suppresses a wrong match and
// watches the tiebreaker re-make it has no remedy at all — and the curated table
// is the documented remedy for exactly the misattribution class the given-name
// guard now catches.
func TestResolveCandidateReturnTiebreakerHonoursAnIgnoreAlias(t *testing.T) {
	f := tiebreakerFixture(t)
	f.candidateAlias("ZZYZXWELL", "Robin", "ignore", nil)

	counts := f.resolve()
	if got := f.candidateSlug("ZZYZXWELL, Robin"); got != "" {
		t.Errorf("the party tiebreaker resolved %q despite an ignore alias; the only override path does not work", got)
	}
	if counts.CandidateResolvedExact != 0 {
		t.Errorf("resolved %d despite an ignore alias, want 0", counts.CandidateResolvedExact)
	}
}

// ---------------------------------------------------------------------------
// The alias table's two key spaces.
// ---------------------------------------------------------------------------

// A curated entry filed in the wrong key format used to be accepted and then
// silently never match. The layer discriminator makes that impossible at entry.
func TestAliasKeyFormatMustMatchItsLayer(t *testing.T) {
	f := newAECResolveFixture(t)
	id := f.politician("Quilberro", "Monique", "monique-quilberro")

	// A rejected INSERT aborts the enclosing transaction, so each case runs
	// inside its own savepoint — one fixture, one TRUNCATE, no second
	// transaction queueing behind this one's locks.
	cases := []struct {
		name, sql string
	}{
		{
			"an entity-format key in the candidate layer",
			`INSERT INTO aec_entity_aliases (alias_norm, target_kind, target_layer, politician_id, curated_by)
			 VALUES ('MONIQUE QUILBERRO', 'politician', 'candidate_name', $1, 'test')`,
		},
		{
			"a candidate-format key in the entity layer",
			`INSERT INTO aec_entity_aliases (alias_norm, target_kind, target_layer, politician_id, curated_by)
			 VALUES ('QUILBERRO|MONIQUE', 'politician', 'entity_name', $1, 'test')`,
		},
		{
			"a company keyed by candidate name, which has no election return",
			`INSERT INTO aec_entity_aliases (alias_norm, target_kind, target_layer, stock_code, curated_by)
			 VALUES ('ACME|WIDGETS', 'company', 'candidate_name', 'XYZ', 'test')`,
		},
	}
	for _, c := range cases {
		if _, err := f.tx.Exec(f.ctx, `SAVEPOINT layer_case`); err != nil {
			t.Fatalf("savepoint: %v", err)
		}
		var err error
		if strings.Contains(c.sql, "politician_id") {
			_, err = f.tx.Exec(f.ctx, c.sql, id)
		} else {
			_, err = f.tx.Exec(f.ctx, c.sql)
		}
		if err == nil {
			t.Errorf("%s was accepted; it can never match anything", c.name)
		}
		if _, err := f.tx.Exec(f.ctx, `ROLLBACK TO SAVEPOINT layer_case`); err != nil {
			t.Fatalf("rollback to savepoint: %v", err)
		}
	}
}

// An entity-layer ignore does not suppress a candidate match, and vice versa —
// the layers are separate on purpose, and a curator must be able to see which
// one they acted on.
func TestCandidateIgnoreAliasDoesNotSuppressAnMPReturn(t *testing.T) {
	f := newAECResolveFixture(t)
	f.politician("Quilberro", "Monique", "monique-quilberro")
	f.mpReturn("Dr Monique Quilberro MP")
	f.candidateAlias("QUILBERRO", "MONIQUE", "ignore", nil)

	f.resolve()
	if got := f.mpSlug("Dr Monique Quilberro MP"); got != "monique-quilberro" {
		t.Errorf("a CANDIDATE-layer ignore suppressed an MP return (slug %q); the layers must not bleed", got)
	}
}

// ---------------------------------------------------------------------------
// Deleting a politician must degrade a return, never fail.
// ---------------------------------------------------------------------------

// ON DELETE SET NULL and the resolution CHECK contradict each other on their
// own: the referential action nulls the id while resolution_method still claims
// a join, so the DELETE errors and the row cannot degrade at all.
func TestDeletingAPoliticianDegradesTheirReturnsInsteadOfFailing(t *testing.T) {
	f := newAECResolveFixture(t)
	id := f.politician("Zzyzxwell", "Peter", "peter-zzyzxwell")
	f.term(id, 47, "Fictionia", "Liberal")
	f.candidateReturn("2022 Federal election", parliamentPtr(47), "Candidate",
		"ZZYZXWELL, Peter Craig", "Fictionia", "Liberal Party of Australia (Victorian Division)")
	f.mpReturn("Mr Peter Zzyzxwell MP")

	f.resolve()
	if got := f.candidateSlug("ZZYZXWELL, Peter Craig"); got != "peter-zzyzxwell" {
		t.Fatalf("fixture did not resolve: slug = %q", got)
	}

	if _, err := f.tx.Exec(f.ctx, `DELETE FROM politicians WHERE id = $1`, id); err != nil {
		t.Fatalf("deleting a politician must degrade the returns, not error: %v", err)
	}

	for _, q := range []struct{ table, column, value string }{
		{"aec_candidate_returns", "candidate_name", "ZZYZXWELL, Peter Craig"},
		{"aec_mp_returns", "member_name", "Mr Peter Zzyzxwell MP"},
	} {
		var politicianID *string
		var method string
		if err := f.tx.QueryRow(f.ctx,
			`SELECT politician_id::text, resolution_method FROM `+q.table+` WHERE `+q.column+` = $1`,
			q.value).Scan(&politicianID, &method); err != nil {
			t.Fatalf("read %s: %v", q.table, err)
		}
		if politicianID != nil {
			t.Errorf("%s still points at the deleted politician", q.table)
		}
		if method != "unresolved" {
			t.Errorf("%s.resolution_method = %q after the join was lost, want unresolved", q.table, method)
		}
	}
}

// ---------------------------------------------------------------------------
// Company matching: the Go and SQL normalisations must agree exactly.
// ---------------------------------------------------------------------------

// normalizeAECEntityName runs in Go over donor names while the company side is
// normalised in SQL inside v_aec_company_name_matches, and the two are then
// joined on EQUALITY. If they ever drift, the join does not fail loudly — it
// silently stops matching, and a company that funded a party quietly disappears
// from the surface. This pins them together against the live expression.
func TestAECEntityNameNormalisationMatchesTheSQL(t *testing.T) {
	f := newAECResolveFixture(t)

	names := []string{
		"Woodside Energy Group Ltd",
		"BHP Group Limited",
		"Commonwealth Bank of Australia",
		"  Australian Labor Party (Western Australian Branch) ",
		"Wesfarmers Limited",
		"Transurban Group",
		"Macquarie Group Holdings Pty Ltd",
		"ANZ",
		"Village Roadshow Corporation Pty. Ltd.",
		"AMP Ltd",
		"Rio Tinto Ltd",
		"Tabcorp Holdings Limited",
		"O'Brien Group Trust",
		"Star Entertainment Grp Ltd",
		"",
	}

	for _, name := range names {
		// The exact expression the view applies to company_name, applied here to
		// the AEC-side string so both sides of the join are compared.
		var sqlNorm string
		err := f.tx.QueryRow(f.ctx, `
			SELECT btrim(regexp_replace(
				btrim(regexp_replace(
					btrim(regexp_replace(upper($1::text), '[^A-Z0-9]+', ' ', 'g')),
					' (LIMITED|LTD|GROUP|HOLDINGS|CORPORATION|PLC|TRUST|PTY|PROPRIETARY)$', '')),
				' (LIMITED|LTD|GROUP|HOLDINGS|CORPORATION|PLC|TRUST|PTY|PROPRIETARY)$', ''))`,
			// The NBSP is cleaned before normalisation in the pipeline, so the
			// SQL side is fed the same cleaned string the Go side receives.
			cleanAECText(name)).Scan(&sqlNorm)
		if err != nil {
			t.Fatalf("sql normalise %q: %v", name, err)
		}
		if got := normalizeAECEntityName(cleanAECText(name)); got != sqlNorm {
			t.Errorf("normalisation drift for %q: Go=%q SQL=%q", name, got, sqlNorm)
		}
	}
}

// A normalised name that maps to more than one stock code is excluded ENTIRELY.
// "XYZ Pty Ltd" is not "XYZ Holdings", and a donor joined to the wrong listed
// company is a misattribution with a share price attached.
func TestAECCompanyMatchViewHasNoAmbiguousNames(t *testing.T) {
	f := newAECResolveFixture(t)

	var dupes int
	if err := f.tx.QueryRow(f.ctx, `
		SELECT count(*) FROM (
			SELECT name_norm FROM v_aec_company_name_matches
			GROUP BY name_norm HAVING count(DISTINCT stock_code) > 1
		) x`).Scan(&dupes); err != nil {
		t.Fatalf("query company match view: %v", err)
	}
	if dupes != 0 {
		t.Errorf("%d normalised names map to more than one stock code; ambiguity must be excluded, not resolved", dupes)
	}

	// And an empty normalised name would match every unparseable donor at once.
	var blanks int
	if err := f.tx.QueryRow(f.ctx,
		`SELECT count(*) FROM v_aec_company_name_matches WHERE coalesce(btrim(name_norm), '') = ''`).
		Scan(&blanks); err != nil {
		t.Fatalf("query blank names: %v", err)
	}
	if blanks != 0 {
		t.Errorf("%d blank normalised names in the company match view", blanks)
	}
}

// An 'ignore' alias must suppress a company match as well as a politician one —
// it is the only override path, and a human judging a name match wrong has to be
// able to act on it.
func TestAECCompanyIgnoreAliasSuppressesAMatch(t *testing.T) {
	f := newAECResolveFixture(t)

	var name string
	var code string
	err := f.tx.QueryRow(f.ctx, `
		SELECT name_norm, stock_code FROM v_aec_company_name_matches
		WHERE match_method = 'name_exact' ORDER BY name_norm LIMIT 1`).Scan(&name, &code)
	if err != nil {
		t.Skipf("no exact company matches in this database: %v", err)
	}

	if _, err := f.tx.Exec(f.ctx, `
		INSERT INTO aec_entity_aliases (alias_norm, target_kind, curated_by, note)
		VALUES ($1, 'ignore', 'aec_donations_resolve_test', 'fixture')`, name); err != nil {
		t.Fatalf("insert ignore alias: %v", err)
	}

	var still int
	if err := f.tx.QueryRow(f.ctx,
		`SELECT count(*) FROM v_aec_company_name_matches WHERE name_norm = $1`, name).Scan(&still); err != nil {
		t.Fatalf("re-query view: %v", err)
	}
	if still != 0 {
		t.Errorf("%q still matches %s after an ignore alias; the override is not effective", name, code)
	}
}

// A merged-away politician row is never a resolution target: the merge retired
// it, and resolving to it would resurrect a slug the feature has stopped using.
func TestResolveIgnoresMergedPoliticians(t *testing.T) {
	f := newAECResolveFixture(t)
	live := f.politician("Quilberro", "Monique", "monique-quilberro")
	merged := f.politician("Quilberro", "Monique", "monique-quilberro-old")
	// A merge must record who did it and why (politicians_merge_needs_evidence);
	// the fixture honours that rather than working around it.
	if _, err := f.tx.Exec(f.ctx, `
		UPDATE politicians
		SET merged_into_id = $1, merged_by = 'aec_donations_resolve_test',
		    merged_at = now(), merge_evidence = 'fixture duplicate'
		WHERE id = $2`, live, merged); err != nil {
		t.Fatalf("merge: %v", err)
	}
	f.mpReturn("Dr Monique Quilberro MP")

	counts := f.resolve()
	// Without the merged_into_id filter this would be an ambiguous pair and
	// withhold; with it, exactly one live politician remains.
	if counts.MPResolvedExact != 1 {
		t.Fatalf("resolved %d, want 1", counts.MPResolvedExact)
	}
	if got := f.mpSlug("Dr Monique Quilberro MP"); got != "monique-quilberro" {
		t.Errorf("slug = %q, want the live row", got)
	}
}
