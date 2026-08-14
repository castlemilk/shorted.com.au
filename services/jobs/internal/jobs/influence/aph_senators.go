package influence

// Senator IDENTITY, from the APH Parliamentary Handbook.
//
// WHAT MAKES THIS DIFFERENT FROM register-handbook. That mode reads the same
// endpoint but only ever ANNOTATES people we already hold: it writes aph_phid
// and profile facts onto rows the register crawl minted. This mode MINTS
// IDENTITY. It is the first thing in the subsystem to create a politicians row
// from something other than a lodged register document, and that is the whole
// point — the Senate register volumes are not loaded, so every senator is
// currently invisible to the photo job, the search index, the funding resolver
// and every read path that starts at politicians.
//
// Because it mints, it is a SIBLING of register-handbook and not part of it,
// it is separately dry-runnable (REGISTER_DRY_RUN defaults true), and it is
// excluded from -mode all like every other register mode.
//
// WHAT IT DOES NOT DO. It writes no declared interest, no holding and no
// amount — there is no Senate register corpus behind it. A senator minted here
// has an identity, a chamber, a state, a party and their occupations, and
// nothing about what they own. Rule 5 is not weakened by a row that carries no
// magnitude column to weaken it with.
//
// THE THREE WAYS THIS COULD FORK A PERSON, and what stops each:
//
//  1. A dual-chamber member is already in the table from their HOUSE service.
//     Keyed on PHID first, so Barnaby Joyce's Senate years land on the Barnaby
//     Joyce we already publish rather than on a second one.
//  2. Two of those rows have an EMPTY phid (Ananda-Rajah, Henderson — they
//     predate register-handbook's coverage). Falling back to person_key catches
//     them, and they are UPDATED into their phid rather than duplicated.
//  3. The Handbook's formal given name differs from the one the register uses
//     for 42 of these people — CANAVAN|MATTHEW here against CANAVAN|MATT there.
//     person_key keeps only the first given name, so the two never collapse on
//     their own. The preferred-name key is checked as a third lookup AND seeded
//     into politician_aliases, which is what lets a future Senate register load
//     resolve "Matt Canavan" onto this row instead of minting a third.
//
// LICENCE. Same as register-handbook: aph.gov.au is CC BY-NC-ND 4.0, so only
// structured FACTS are taken and no APH prose is rewritten.

import (
	"context"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// senatorSourceURL is the provenance recorded on every row this mode writes.
const senatorSourceURL = handbookIndividualsURL

// senateStateCodes maps the Handbook's full state name to the code
// politician_terms already uses for House terms — and, not by coincidence, the
// code the AEC writes in aec_candidate_returns.electorate_state. Rule 3c joins
// those two columns directly, so a divergence here would silently resolve
// nothing rather than fail.
var senateStateCodes = map[string]string{
	"new south wales":              "NSW",
	"victoria":                     "VIC",
	"queensland":                   "QLD",
	"south australia":              "SA",
	"western australia":            "WA",
	"tasmania":                     "TAS",
	"northern territory":           "NT",
	"australian capital territory": "ACT",
}

// stateRegionName expands a state code back into the full name external
// sources use ("VIC" → "Victoria"). Anything it does not recognise passes
// through unchanged, so a column that already holds a full name is untouched.
func stateRegionName(code string) string {
	if name, ok := senateStateNames[strings.ToUpper(strings.TrimSpace(code))]; ok {
		return name
	}
	return code
}

// senateStateNames is the reverse of senateStateCodes.
var senateStateNames = map[string]string{
	"NSW": "New South Wales",
	"VIC": "Victoria",
	"QLD": "Queensland",
	"SA":  "South Australia",
	"WA":  "Western Australia",
	"TAS": "Tasmania",
	"NT":  "Northern Territory",
	"ACT": "Australian Capital Territory",
}

// senateTerm is one derived Senate term.
type senateTerm struct {
	Parliament int
	StateCode  string
	Party      string
	PartyAb    string
	Start      *time.Time
	End        *time.Time
}

// senatorIdentity is one Handbook person, reduced to what we mint.
type senatorIdentity struct {
	PHID string

	// PersonKey comes from the FORMAL given name, because that is what
	// person_key means everywhere else in the subsystem and a key that
	// sometimes means the preferred name is not a key.
	PersonKey string
	// PreferredKey is the SAME person under the name the register, the AEC and
	// the press actually use. Seeded as an alias, never as the person_key.
	PreferredKey string

	Surname     string
	GivenNames  string
	DisplayName string
	SlugBase    string

	Terms []senateTerm
}

// isSenator is the population filter.
//
// MPorSenator is a LIST and the test is membership, not equality: 14 of these
// people are also members, and an equality test would drop every dual-chamber
// senator — the exact population every other rule here is written to get right.
func isSenator(h handbookIndividual) bool {
	for _, role := range h.MPorSenator {
		if strings.EqualFold(strings.TrimSpace(role), "Senator") {
			return true
		}
	}
	return false
}

// maxParliament is the latest parliament a Handbook record claims.
func maxParliament(parliaments []int) int {
	out := 0
	for _, p := range parliaments {
		if p > out {
			out = p
		}
	}
	return out
}

// houseIntervals are the dated House terms to subtract.
func houseIntervals(h handbookIndividual) []dateInterval {
	var out []dateInterval
	for _, es := range h.ElectorateService {
		if iv, ok := handbookInterval(es.ServiceStart, es.ServiceEnd); ok {
			out = append(out, iv)
		}
	}
	return out
}

// senateIntervals subtracts the House out of the whole parliamentary career.
func senateIntervals(h handbookIndividual) []dateInterval {
	house := houseIntervals(h)
	var out []dateInterval
	for _, ps := range h.PartyParliamentaryService {
		iv, ok := handbookInterval(ps.DateStart, ps.DateEnd)
		if !ok {
			continue
		}
		out = append(out, subtractIntervals(iv, house)...)
	}
	return out
}

// partyIntervals collects the DATED party affiliations. 29 of these senators
// changed party mid-career, so a single Party field would label the whole
// history with whichever one they finished under.
func partyIntervals(h handbookIndividual) []struct {
	Span  dateInterval
	Party string
} {
	var out []struct {
		Span  dateInterval
		Party string
	}
	for _, ps := range h.PartyParliamentaryService {
		for _, sec := range ps.SecondaryService {
			if !strings.EqualFold(strings.TrimSpace(sec.RoSType), "Parties Represented") {
				continue
			}
			party := strings.TrimSpace(sec.Value)
			if party == "" {
				continue
			}
			iv, ok := handbookInterval(sec.DateStart, sec.DateEnd)
			if !ok {
				continue
			}
			out = append(out, struct {
				Span  dateInterval
				Party string
			}{iv, party})
		}
	}
	return out
}

// partyForSpan picks the party that held the LONGEST share of a span.
//
// A DEAD HEAT WITHHOLDS. Two parties covering a parliament equally is a person
// who crossed the floor mid-term, and naming one of them on their profile for
// that parliament states as fact something the source does not decide. An empty
// party renders as "not recorded", which is true; a coin-flip renders as a
// party affiliation, which may not be.
func partyForSpan(h handbookIndividual, span dateInterval) (string, string) {
	best, bestDays := "", 0.0
	tied := false
	for _, pi := range partyIntervals(h) {
		shared, ok := pi.Span.intersect(span)
		if !ok {
			continue
		}
		d := shared.days()
		switch {
		case d > bestDays+0.5:
			best, bestDays, tied = pi.Party, d, false
		case d > bestDays-0.5 && pi.Party != best:
			tied = true
		}
	}
	if tied || best == "" {
		return "", ""
	}
	// The abbreviation is only published when it is KNOWN to belong to this
	// party name. PartyAbbrev describes the person's CURRENT party only, so
	// pairing it with a historical party name would invent an abbreviation.
	ab := ""
	if strings.EqualFold(strings.TrimSpace(h.Party), best) {
		ab = normalisePartyAbbrev(h.PartyAbbrev)
	}
	return best, ab
}

// normalisePartyAbbrev makes the Handbook's abbreviation the SAME CODE the rest
// of the product already uses for that party.
//
// THIS IS A CODE, NOT PROSE. The ND term on aph.gov.au forbids rewriting APH's
// words, and `party` — the party's NAME — is stored verbatim for exactly that
// reason. `party_ab` is a machine key: it is never the label a reader sees, it
// is what the palette, the party chips and the Algolia facet look a party up
// BY, and two codes for one party split that party in every one of them.
//
// Two rewrites, and only these two, because only these two are the same party
// under a second code:
//
//   - PHON -> ON. The Handbook writes PHON for "Pauline Hanson's One Nation"
//     and ON for "One Nation". One party, two codes — and the product's palette
//     knows ON. Left alone they were two facet buckets and two colours, one of
//     them a grey "Other".
//   - "UAP [2018]" -> UAP. The bracketed year is a DISAMBIGUATOR for a party's
//     re-registration, not part of the abbreviation; nothing downstream keys on
//     it and every consumer that tries reads it as an unknown party. Stripped
//     generically, so any future qualifier lands the same way. The party NAME
//     keeps the qualifier, verbatim, which is where that distinction is
//     actually recorded.
//
// Everything else passes through untouched. A code we do not recognise is not
// this function's business — the fix for an unknown party is a palette entry,
// not a rewrite here.
func normalisePartyAbbrev(raw string) string {
	ab := strings.TrimSpace(raw)
	// Strip a trailing bracketed qualifier: "UAP [2018]" -> "UAP".
	if i := strings.Index(ab, "["); i > 0 {
		ab = strings.TrimSpace(ab[:i])
	}
	if strings.EqualFold(ab, "PHON") {
		return "ON"
	}
	return ab
}

// stateCodeOf normalises anything the Handbook writes for a state — a full name
// ("New South Wales"), an abbreviation ("NSW"), or the mixed case it uses in
// RepresentedStates ("Qld") — to the single upper-case code politician_terms
// stores. Anything unrecognised is upper-cased and passed through, so it
// compares as itself rather than silently collapsing into another state.
func stateCodeOf(s string) string {
	trimmed := strings.TrimSpace(s)
	if code, ok := senateStateCodes[strings.ToLower(trimmed)]; ok {
		return code
	}
	return strings.ToUpper(trimmed)
}

// senateStatesAmbiguous reports whether this person's SENATE state cannot be
// read off the single `SenateState` field.
//
// `RepresentedStates` spans the WHOLE CAREER AND BOTH CHAMBERS, so a
// dual-chamber person lists their House state in it too: Barnaby Joyce reads
// ['NSW', 'Qld'] — New England in the House, Queensland in the Senate — and
// naively counting that as two Senate states would withhold a state we know
// perfectly well. The House states come out first, from the person's own dated
// ElectorateService, and only what remains is a candidate Senate state.
//
// More than one left over is the case this file cannot represent, and it
// withholds. Measured against the live payload: zero of the 180 senators in
// range. This is a tripwire, not a live branch.
func senateStatesAmbiguous(h handbookIndividual) bool {
	house := map[string]bool{}
	for _, es := range h.ElectorateService {
		if code := stateCodeOf(es.State); code != "" {
			house[code] = true
		}
	}
	senate := map[string]bool{}
	for _, s := range h.RepresentedStates {
		code := stateCodeOf(s)
		if code == "" || house[code] {
			continue
		}
		senate[code] = true
	}
	return len(senate) > 1
}

// deriveSenateTerms turns one Handbook record into Senate terms.
//
// Intersected with RepresentedParliaments as a belt-and-braces bound: the date
// arithmetic decides WHICH parliaments, but the Handbook's own list decides the
// outer envelope, so an off-by-one at a parliament boundary can never invent a
// sitting the source does not claim.
func deriveSenateTerms(h handbookIndividual) []senateTerm {
	claimed := map[int]bool{}
	for _, p := range h.RepresentedParliaments {
		claimed[p] = true
	}
	intervals := senateIntervals(h)
	covered := parliamentsCovered(intervals)

	// THE STATE IS CAREER-WIDE, AND IT IS STAMPED ON EVERY TERM. A KNOWN
	// LIMITATION.
	//
	// `SenateState` is ONE field on the Handbook person: it names the state they
	// represent, not the state they represented in each parliament. There is no
	// per-parliament state anywhere in the payload, so every Senate term this
	// function writes carries the same code — which is correct for a senator who
	// never changed state and WRONG for one who did.
	//
	// It is safe TODAY because nobody in range did: across all 180 senators the
	// mode considers, ZERO have more than one Senate state once their House
	// states are set aside (measured against the live payload). But "safe today"
	// is not a property of the code, so `senateStatesAmbiguous` makes it one:
	// when the Handbook's own `RepresentedStates` cannot be reduced to a single
	// Senate state, the code is WITHHELD rather than guessed, and the term
	// renders as a senator with no state instead of a senator for the wrong one.
	//
	// A wrong state here is not cosmetic. Rule 3c joins Senate candidate returns
	// on `state_code`, so a stale state would offer one state's whole slate of
	// declared money to somebody who was never on it. When the withhold ever
	// fires, the fix is a real per-term state — the dated-interval treatment
	// `partyForSpan` already applies to party, applied to state — not a looser
	// guess here.
	stateCode := ""
	if !senateStatesAmbiguous(h) {
		stateCode = senateStateCodes[strings.ToLower(strings.TrimSpace(h.SenateState))]
	}

	parliaments := make([]int, 0, len(covered))
	for p := range covered {
		if p >= minSenateParliament && claimed[p] {
			parliaments = append(parliaments, p)
		}
	}
	sort.Ints(parliaments)

	now := time.Now().UTC()
	var out []senateTerm
	for _, p := range parliaments {
		span, ok := parliamentSpan(p)
		if !ok {
			continue
		}
		// The served part of this parliament: the union of the Senate intervals
		// clipped to the parliament's span.
		var start, end time.Time
		for _, iv := range intervals {
			shared, ok := iv.intersect(span)
			if !ok {
				continue
			}
			if start.IsZero() || shared.From.Before(start) {
				start = shared.From
			}
			if end.IsZero() || shared.To.After(end) {
				end = shared.To
			}
		}
		term := senateTerm{Parliament: p, StateCode: stateCode}
		term.Party, term.PartyAb = partyForSpan(h, span)

		// THE DATES RECORD ONLY WHAT IS NOT ALREADY IMPLIED BY THE PARLIAMENT.
		//
		// A row in politician_terms is keyed on (person, parliament, chamber),
		// so "served this parliament" is the row's own meaning. Writing the
		// clipped span's ends into it would state, of a senator who served the
		// whole 45th, that their term BEGAN on election day 2016 and ENDED on
		// election day 2019 — neither of which happened; the parliament turned
		// over. Only a mid-parliament boundary is a fact about the person:
		// Sarah Henderson filling a casual vacancy on 11 September 2019, four
		// months into the 46th, is one. A boundary equal to the parliament's own
		// is left NULL, and reads as "the whole parliament".
		if !start.IsZero() && start.After(span.From) {
			s := start
			term.Start = &s
		}
		// A CURRENT term has no end, and the Handbook does not say so in words:
		// it writes TODAY'S DATE as the end of an ongoing interval, because the
		// payload is generated per request. Stored literally, every sitting
		// senator's term reads as having ended on the day of the run — which it
		// did, in the first version of this function, for all 41 of them.
		// A day of grace covers the AEST/UTC offset between their clock and ours.
		ongoingFrom := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, -1)
		if !end.IsZero() && end.Before(span.To) && end.Before(ongoingFrom) {
			e := end
			term.End = &e
		}
		out = append(out, term)
	}
	return out
}

// senatorDisplayName renders a Handbook FamilyName for display.
//
// The Handbook upper-cases surnames but PRESERVES the mixed-case prefixes that
// matter — "McGRATH", "MacDONALD", "O'NEILL". Naive title-casing destroys those
// ("Mcgrath"), and a name is the one field on a person's profile that has to be
// right. So each part keeps whatever mixed-case prefix it already has and only
// the trailing all-caps run is title-cased. Parts split on space, hyphen and
// apostrophe, which covers ANANDA-RAJAH, DI NATALE and O'SULLIVAN.
func senatorSurname(family string) string {
	var b strings.Builder
	part := strings.Builder{}
	flush := func() {
		b.WriteString(titleCaseNamePart(part.String()))
		part.Reset()
	}
	for _, r := range family {
		if r == ' ' || r == '-' || r == '\'' || r == '’' {
			flush()
			b.WriteRune(r)
			continue
		}
		part.WriteRune(r)
	}
	flush()
	return b.String()
}

// titleCaseNamePart lower-cases only the trailing capitals of one name part,
// keeping any prefix that already carries lower-case letters ("Mac", "Mc").
func titleCaseNamePart(s string) string {
	if s == "" {
		return ""
	}
	runes := []rune(s)
	// The prefix ends after the LAST lower-case letter, if any.
	prefixEnd := 0
	for i, r := range runes {
		if r >= 'a' && r <= 'z' {
			prefixEnd = i + 1
		}
	}
	if prefixEnd == 0 {
		return string(runes[0]) + strings.ToLower(string(runes[1:]))
	}
	rest := runes[prefixEnd:]
	if len(rest) == 0 {
		return s
	}
	return string(runes[:prefixEnd]) + string(rest[0]) + strings.ToLower(string(rest[1:]))
}

// preferredGivenName strips the Handbook's parentheses: "(Matt)" → "Matt".
func preferredGivenName(h handbookIndividual) string {
	return strings.TrimSpace(strings.Trim(strings.TrimSpace(h.PreferredName), "()"))
}

// buildSenatorIdentity reduces a Handbook record to what gets minted.
//
// GivenNames deliberately excludes MiddleNames. aec_given_names_agree matches
// if EITHER side's first token appears anywhere in the other, so storing
// "Matthew James" would let a candidate return for a different "James" agree
// with Matthew — the losing-namesake failure rule 3 was rewritten to stop.
// Storing only the first given name still agrees with an AEC "Matthew James"
// (its first token matches ours) while refusing the namesake.
func buildSenatorIdentity(h handbookIndividual) (senatorIdentity, bool) {
	family := strings.TrimSpace(h.FamilyName)
	formal := strings.TrimSpace(h.GivenName)
	if family == "" || formal == "" || strings.TrimSpace(h.PHID) == "" {
		return senatorIdentity{}, false
	}
	surname := senatorSurname(family)
	preferred := preferredGivenName(h)
	display := preferred
	if display == "" {
		display = formal
	}

	id := senatorIdentity{
		PHID:        strings.TrimSpace(h.PHID),
		PersonKey:   personKey(surname, formal),
		Surname:     surname,
		GivenNames:  formal,
		DisplayName: strings.TrimSpace(display + " " + surname),
		SlugBase:    slugify(display + " " + surname),
		Terms:       deriveSenateTerms(h),
	}
	if id.PersonKey == "" {
		return senatorIdentity{}, false
	}
	if preferred != "" {
		if pk := personKey(surname, preferred); pk != id.PersonKey {
			id.PreferredKey = pk
		}
	}
	return id, true
}

// selectSenators filters the Handbook payload to the population this mode owns.
func selectSenators(individuals []handbookIndividual) []senatorIdentity {
	var out []senatorIdentity
	for _, h := range individuals {
		if !isSenator(h) {
			continue
		}
		if maxParliament(h.RepresentedParliaments) < minSenateParliament {
			continue
		}
		if id, ok := buildSenatorIdentity(h); ok {
			out = append(out, id)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].PHID < out[j].PHID })
	return out
}

// senatorUpsertStats is what the operator gets back.
type senatorUpsertStats struct {
	Considered       int
	Minted           int
	MatchedPHID      int
	MatchedKey       int
	MatchedPreferred int
	Terms            int
	Aliases          int
	AliasSkipped     int
	Conflicts        int
	NoTerms          int
}

// findSenator resolves an existing person, in the ONE order that cannot fork.
//
//	PHID          the Handbook's own stable id, and the only key that is
//	              authoritative rather than derived from a name
//	person_key    catches the rows minted before register-handbook ran, which
//	              have no phid to match on
//	preferred key catches a person the register recorded under their preferred
//	              name, whether that key is a person_key or an alias
//
// Anything else MINTS, and minting a duplicate is the failure this order
// exists to avoid.
func findSenator(ctx context.Context, tx pgx.Tx, id senatorIdentity) (politicianID, matchedBy string, err error) {
	scan := func(q string, arg any) (string, error) {
		var out string
		err := tx.QueryRow(ctx, q, arg).Scan(&out)
		if err == pgx.ErrNoRows {
			return "", nil
		}
		return out, err
	}

	// THE PHID LOOKUP IS NOT UNIQUE, and assuming it was is how this mode would
	// have written to an arbitrary one of two rows. 28 PHIDs are held by TWO
	// politicians each — chris-bowen/christopher-bowen, matt/matthew-
	// thistlethwaite, the whole preferred-name fork register-handbook already
	// reports. Taking "the first row" there is a coin flip re-tossed on every
	// run, and the two halves of a split identity carry different declared
	// histories. Two rows means the identity is DISPUTED, and a disputed
	// identity is a curator's decision (000103's CHECK), so it withholds.
	var phidRows int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM politicians WHERE btrim(aph_phid) = $1`, id.PHID).
		Scan(&phidRows); err != nil {
		return "", "", err
	}
	if phidRows > 1 {
		return "", "ambiguous_phid", nil
	}

	pid, err := scan(`SELECT id::text FROM politicians WHERE btrim(aph_phid) = $1`, id.PHID)
	if err != nil {
		return "", "", err
	}
	if pid != "" {
		return pid, "phid", nil
	}

	pid, err = scan(`SELECT id::text FROM politicians WHERE person_key = $1`, id.PersonKey)
	if err != nil {
		return "", "", err
	}
	if pid != "" {
		return pid, "person_key", nil
	}

	if id.PreferredKey != "" {
		pid, err = scan(`SELECT id::text FROM politicians WHERE person_key = $1`, id.PreferredKey)
		if err != nil {
			return "", "", err
		}
		if pid != "" {
			return pid, "preferred_key", nil
		}
		pid, err = scan(`
			SELECT p.id::text FROM politician_aliases a
			JOIN politicians p ON p.id = a.politician_id
			WHERE a.alias_key = $1`, id.PreferredKey)
		if err != nil {
			return "", "", err
		}
		if pid != "" {
			return pid, "preferred_alias", nil
		}
	}
	return "", "", nil
}

// upsertSenator writes one person, their Senate terms and their name aliases.
func upsertSenator(ctx context.Context, tx pgx.Tx, id senatorIdentity, stats *senatorUpsertStats) error {
	politicianID, matchedBy, err := findSenator(ctx, tx, id)
	if err != nil {
		return err
	}

	// A disputed identity writes NOTHING — not to either half, and certainly not
	// a third row beside them. Falling through to the person_key lookup would
	// pick one half of the fork just as arbitrarily as the phid lookup did.
	if matchedBy == "ambiguous_phid" {
		stats.Conflicts++
		log.Printf("[register-senators] AMBIGUOUS %s: phid %s is held by more than one politicians row — withheld until a curator merges them",
			id.DisplayName, id.PHID)
		return nil
	}

	if politicianID != "" {
		// A row already carrying a DIFFERENT phid is two different people
		// colliding on a name key. Writing to it would move a stranger's Senate
		// career onto a named person, so it withholds and reports.
		var existingPHID string
		if err := tx.QueryRow(ctx, `SELECT btrim(aph_phid) FROM politicians WHERE id = $1`, politicianID).
			Scan(&existingPHID); err != nil {
			return err
		}
		if existingPHID != "" && existingPHID != id.PHID {
			stats.Conflicts++
			log.Printf("[register-senators] CONFLICT %s (%s): matched an existing row by %s that already holds phid %s — withheld",
				id.DisplayName, id.PHID, matchedBy, existingPHID)
			return nil
		}
	}

	firstParl, lastParl := 0, 0
	for _, t := range id.Terms {
		if firstParl == 0 || t.Parliament < firstParl {
			firstParl = t.Parliament
		}
		if t.Parliament > lastParl {
			lastParl = t.Parliament
		}
	}

	if politicianID == "" {
		// Nothing to mint an identity FOR. A person flagged Senator whose Senate
		// service all predates parliament 44 (Barnaby Joyce, Bronwyn Bishop) has
		// no Senate term in range; if they are not already in the table, a row
		// carrying no term and no declared interest would be an empty profile.
		if len(id.Terms) == 0 {
			stats.NoTerms++
			return nil
		}
		slug, err := mintSlug(ctx, tx, PersonIdentity{
			Surname:     id.Surname,
			DisplayName: id.DisplayName,
			SlugBase:    id.SlugBase,
		}, "")
		if err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO politicians
				(person_key, surname, given_names, display_name, slug, aph_phid,
				 first_parliament, last_parliament, source_url)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			RETURNING id::text`,
			id.PersonKey, id.Surname, id.GivenNames, id.DisplayName, slug, id.PHID,
			nullableParliament(firstParl), nullableParliament(lastParl), senatorSourceURL).
			Scan(&politicianID); err != nil {
			return fmt.Errorf("mint %s: %w", id.DisplayName, err)
		}
		stats.Minted++
	} else {
		// The slug and the display name are NEVER touched. Both are already
		// published — the slug reaches OG images and the sitemap, the display
		// name reaches every cross-link — and this mode has no better claim on
		// either than the register load that minted them.
		if _, err := tx.Exec(ctx, `
			UPDATE politicians SET
				aph_phid         = CASE WHEN btrim(aph_phid) = '' THEN $2 ELSE aph_phid END,
				first_parliament = CASE WHEN $3::int IS NULL THEN first_parliament
				                        ELSE LEAST(COALESCE(first_parliament, $3), $3) END,
				last_parliament  = CASE WHEN $4::int IS NULL THEN last_parliament
				                        ELSE GREATEST(COALESCE(last_parliament, $4), $4) END,
				updated_at       = now()
			WHERE id = $1`,
			politicianID, id.PHID, nullableParliament(firstParl), nullableParliament(lastParl)); err != nil {
			return fmt.Errorf("update %s: %w", id.DisplayName, err)
		}
		switch matchedBy {
		case "phid":
			stats.MatchedPHID++
		case "person_key":
			stats.MatchedKey++
		default:
			stats.MatchedPreferred++
		}
	}

	for _, t := range id.Terms {
		if _, err := tx.Exec(ctx, `
			INSERT INTO politician_terms
				(politician_id, parliament, chamber, state_code, party, party_ab,
				 term_start, term_end, source, source_licence, source_url)
			VALUES ($1, $2, 'senate', NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''),
			        $6, $7, $8, $9, $10)
			ON CONFLICT (politician_id, parliament, chamber) DO UPDATE SET
				state_code = COALESCE(NULLIF(EXCLUDED.state_code, ''), politician_terms.state_code),
				party      = COALESCE(NULLIF(EXCLUDED.party, ''), politician_terms.party),
				party_ab   = COALESCE(NULLIF(EXCLUDED.party_ab, ''), politician_terms.party_ab),
				term_start = COALESCE(EXCLUDED.term_start, politician_terms.term_start),
				term_end   = COALESCE(EXCLUDED.term_end, politician_terms.term_end)`,
			politicianID, t.Parliament, t.StateCode, t.Party, t.PartyAb,
			t.Start, t.End, handbookSourceKey, handbookLicence, senatorSourceURL); err != nil {
			return fmt.Errorf("term %d for %s: %w", t.Parliament, id.DisplayName, err)
		}
		stats.Terms++
	}

	// The alias rows. The formal key is recorded for the same audit reason
	// resolvePolitician records one; the PREFERRED key is the one that does
	// work — it is how a future Senate register load, which will write "Matt
	// Canavan", reaches the row minted here under CANAVAN|MATTHEW.
	for _, key := range []string{id.PersonKey, id.PreferredKey} {
		if key == "" {
			continue
		}
		// An alias key that is ALREADY some politician's person_key is
		// unreachable: every resolver checks politicians.person_key first. If it
		// belongs to somebody else it is also a live duplicate identity, which
		// is a curator's call (000103's CHECK), never this mode's.
		var owner string
		if err := tx.QueryRow(ctx, `SELECT COALESCE((SELECT id::text FROM politicians WHERE person_key = $1), '')`, key).
			Scan(&owner); err != nil {
			return err
		}
		if owner != "" && owner != politicianID {
			stats.AliasSkipped++
			log.Printf("[register-senators] alias %s not seeded for %s: it is already another person's person_key — a merge is a curator's decision",
				key, id.DisplayName)
			continue
		}
		if owner != "" {
			continue
		}
		tag, err := tx.Exec(ctx, `
			INSERT INTO politician_aliases (alias_key, politician_id, alias_raw, alias_kind)
			VALUES ($1, $2, $3, 'observed')
			ON CONFLICT (alias_key) DO NOTHING`, key, politicianID, id.DisplayName)
		if err != nil {
			return fmt.Errorf("alias %s for %s: %w", key, id.DisplayName, err)
		}
		stats.Aliases += int(tag.RowsAffected())
	}
	return nil
}

func nullableParliament(p int) any {
	if p == 0 {
		return nil
	}
	return p
}

// runRegisterSenators fetches, derives and upserts.
func runRegisterSenators(ctx context.Context, pool *pgxpool.Pool, dryRun bool) (int, error) {
	individuals, err := fetchHandbookIndividuals(ctx)
	if err != nil {
		return 0, err
	}
	senators := selectSenators(individuals)
	log.Printf("[register-senators] %d handbook records, %d senators from parliament %d onwards",
		len(individuals), len(senators), minSenateParliament)

	stats := senatorUpsertStats{Considered: len(senators)}

	if dryRun {
		terms, aliases, dual := 0, 0, 0
		for _, s := range senators {
			terms += len(s.Terms)
			if s.PreferredKey != "" {
				aliases++
			}
			if len(s.Terms) == 0 {
				dual++
			}
		}
		log.Printf("[register-senators] DRY RUN — %d people, %d senate terms, %d preferred-name aliases, %d with no term in range",
			len(senators), terms, aliases, dual)
		for i, s := range senators {
			if i >= 5 {
				break
			}
			log.Printf("[register-senators]   %-30s %-24s parliaments %v", s.DisplayName, s.PersonKey, termParliaments(s.Terms))
		}
		return len(senators), nil
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	for _, s := range senators {
		if err := upsertSenator(ctx, tx, s, &stats); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}

	log.Printf("[register-senators] minted %d, matched %d by phid / %d by person_key / %d by preferred name; %d senate terms, %d aliases seeded (%d withheld), %d conflicts, %d skipped with no term in range",
		stats.Minted, stats.MatchedPHID, stats.MatchedKey, stats.MatchedPreferred,
		stats.Terms, stats.Aliases, stats.AliasSkipped, stats.Conflicts, stats.NoTerms)
	return stats.Minted + stats.MatchedPHID + stats.MatchedKey + stats.MatchedPreferred, nil
}

func termParliaments(terms []senateTerm) []int {
	out := make([]int, 0, len(terms))
	for _, t := range terms {
		out = append(out, t.Parliament)
	}
	return out
}
