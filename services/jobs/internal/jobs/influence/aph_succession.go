package influence

// Document succession on the House listings.
//
// source_url is the manifest's identity, so when APH re-points a member's row at
// a different URL the new URL is a new document. That happened wholesale in
// 2026: the 48th Parliament register moved from /-/media/…/X_48P.pdf onto
// interests-register-api-public.aph.gov.au, 147 of 151 rows at once. Two things
// go wrong if the old and new rows are not linked:
//
//  1. Duplicates. Both documents load, and a member's declarations publish twice
//     for the same parliament.
//  2. A second person. The move also EDITED listing text — "Pasin, Mr Antony"
//     became "Pasin, Mr Tony", "Brynes" became "Byrnes", "France. Ms Ali" lost
//     its stray full stop. The new row resolves by name, the key differs, and
//     resolvePolitician mints someone beside the person we already publish. That
//     is exactly the mechanism behind the 28 duplicate identities on prod.
//
// So discover links a departed row to the row that replaced it, and load carries
// the predecessor's resolved identity forward (aph_load.go).
//
// # Pairing is deliberately conservative
//
// A wrong pairing attaches one person's declarations to another person's name —
// the worst failure this subsystem has. So pairing happens only within one
// parliament AND one division, only between a row that has LEFT the listing and
// a row that ARRIVED after it was last seen, and only on:
//
//   - a matching surname (after letters-only normalisation, and allowing the
//     "Surname. Honorific Given" typo form), unique in both directions; or
//   - failing that, a one-to-one division whose surnames differ by a transposed
//     or mistyped letter or two AND whose first given names are identical and
//     non-empty. That is the "Brynes" -> "Byrnes" correction, and nothing looser.
//
// Everything else stays unpaired. Load then WITHHOLDS the new row while an
// unpaired departed row in its division still publishes, and a person decides.
// A by-election is the case this protects: the former member and the new member
// share a division and a parliament, and a division-only match would hand one
// the other's history.

import (
	"context"
	"fmt"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5/pgxpool"
)

// successionRow is the pairing view of one House manifest row.
type successionRow struct {
	ID         string
	Parliament int
	MemberHint string
	Division   string
	// Gone rows: when the listing last carried the row (or when it was first
	// discovered, for rows that predate last_listed_at). Arrived rows: when the
	// row was first discovered.
	Seen time.Time
}

type successionStats struct {
	Departed int // rows no longer on their listing and not yet superseded
	Linked   int
	Unpaired int // departed rows left without a successor
}

// pairSuccessors returns departed-row id -> arriving-row id.
//
// Pure, so every pairing rule is testable without a database.
func pairSuccessors(gone, arrived []successionRow) map[string]string {
	type groupKey struct {
		parliament int
		division   string
	}
	gByKey := map[groupKey][]successionRow{}
	for _, g := range gone {
		k := groupKey{g.Parliament, lettersUpper(g.Division)}
		if k.division == "" {
			continue // no division, no safe grouping
		}
		gByKey[k] = append(gByKey[k], g)
	}
	aByKey := map[groupKey][]successionRow{}
	for _, a := range arrived {
		k := groupKey{a.Parliament, lettersUpper(a.Division)}
		if k.division == "" {
			continue
		}
		aByKey[k] = append(aByKey[k], a)
	}

	pairs := map[string]string{}
	for k, gs := range gByKey {
		as := aByKey[k]
		if len(as) == 0 {
			continue
		}
		pairedG := map[string]bool{}
		pairedA := map[string]bool{}

		// 1. Surname matches, unique in both directions.
		for _, a := range as {
			var cands []successionRow
			for _, g := range gs {
				if a.Seen.After(g.Seen) && surnamesMatch(g.MemberHint, a.MemberHint) {
					cands = append(cands, g)
				}
			}
			if len(cands) != 1 {
				continue
			}
			g := cands[0]
			back := 0
			for _, other := range as {
				if other.Seen.After(g.Seen) && surnamesMatch(g.MemberHint, other.MemberHint) {
					back++
				}
			}
			if back != 1 || pairedG[g.ID] {
				continue
			}
			pairs[g.ID] = a.ID
			pairedG[g.ID], pairedA[a.ID] = true, true
		}

		// 2. A one-to-one remainder that differs only by a small spelling
		// correction, with an identical first given name.
		var restG, restA []successionRow
		for _, g := range gs {
			if !pairedG[g.ID] {
				restG = append(restG, g)
			}
		}
		for _, a := range as {
			if !pairedA[a.ID] {
				restA = append(restA, a)
			}
		}
		if len(restG) == 1 && len(restA) == 1 && restA[0].Seen.After(restG[0].Seen) &&
			spellingCorrection(restG[0].MemberHint, restA[0].MemberHint) {
			pairs[restG[0].ID] = restA[0].ID
		}
	}
	return pairs
}

// surnamesMatch compares the surname a listing cell leads with. Both the
// comma-delimited and the full-stop-delimited forms are tried, because the
// listing has carried "France. Ms Ali, Member for Dickson" — a full stop where
// the comma belongs, which puts the honorific and given name into the "surname".
func surnamesMatch(a, b string) bool {
	forms := surnameForms(b)
	for _, x := range surnameForms(a) {
		if slices.Contains(forms, x) {
			return true
		}
	}
	return false
}

func surnameForms(hint string) []string {
	var out []string
	seen := map[string]bool{}
	for _, sep := range []string{",", "."} {
		head, _, found := strings.Cut(hint, sep)
		if !found && sep == "." {
			continue // no full stop: the comma form already covers it
		}
		if f := lettersUpper(head); f != "" && !seen[f] {
			seen[f] = true
			out = append(out, f)
		}
	}
	return out
}

// spellingCorrection: surnames within an edit distance of two (transposition
// counted as one), at least four letters long, and the same non-empty first
// given name. "BRYNES|ALISON" -> "BYRNES|ALISON" passes; a different person in
// the same seat essentially never shares both.
func spellingCorrection(a, b string) bool {
	ia, ib := parseMemberHint(a), parseMemberHint(b)
	sa, sb := lettersUpper(ia.Surname), lettersUpper(ib.Surname)
	if len(sa) < 4 || len(sb) < 4 {
		return false
	}
	ga, gb := firstGiven(ia.PersonKey), firstGiven(ib.PersonKey)
	if ga == "" || ga != gb {
		return false
	}
	return osaDistance(sa, sb) <= 2
}

func firstGiven(personKey string) string {
	_, given, _ := strings.Cut(personKey, "|")
	return given
}

func lettersUpper(s string) string {
	var b strings.Builder
	for _, r := range s {
		if unicode.IsLetter(r) {
			b.WriteRune(unicode.ToUpper(r))
		}
	}
	return b.String()
}

// osaDistance is the optimal-string-alignment edit distance: Levenshtein plus
// adjacent transposition as a single edit.
func osaDistance(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	d := make([][]int, len(ra)+1)
	for i := range d {
		d[i] = make([]int, len(rb)+1)
		d[i][0] = i
	}
	for j := range d[0] {
		d[0][j] = j
	}
	for i := 1; i <= len(ra); i++ {
		for j := 1; j <= len(rb); j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			d[i][j] = min(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1]+cost)
			if i > 1 && j > 1 && ra[i-1] == rb[j-2] && ra[i-2] == rb[j-1] {
				d[i][j] = min(d[i][j], d[i-2][j-2]+1)
			}
		}
	}
	return d[len(ra)][len(rb)]
}

// recordHouseSuccession links rows that left their House listing in this
// discover run to the rows that replaced them.
//
// listedAt must be the value upsertRegisterDocuments stamped on this run's
// rows, and every parliament in `parliaments` must have been parsed in FULL by
// that run — a row missing from a truncated listing is not a row that left it.
func recordHouseSuccession(ctx context.Context, pool *pgxpool.Pool, listedAt time.Time, parliaments []int) (successionStats, error) {
	var stats successionStats
	if len(parliaments) == 0 {
		return stats, nil
	}

	goneRows, err := pool.Query(ctx, `
		SELECT d.id::text, d.parliament, d.member_hint, d.division_hint,
		       COALESCE(d.last_listed_at, d.discovered_at)
		FROM register_documents d
		WHERE d.chamber = 'house'
		  AND d.parliament = ANY($2)
		  AND d.superseded_by IS NULL
		  AND (d.last_listed_at IS NULL OR d.last_listed_at < $1)`, listedAt, parliaments)
	if err != nil {
		return stats, fmt.Errorf("select departed rows: %w", err)
	}
	gone, err := scanSuccessionRows(goneRows)
	if err != nil {
		return stats, fmt.Errorf("scan departed rows: %w", err)
	}
	stats.Departed = len(gone)
	if len(gone) == 0 {
		return stats, nil
	}

	arrivedRows, err := pool.Query(ctx, `
		SELECT d.id::text, d.parliament, d.member_hint, d.division_hint, d.discovered_at
		FROM register_documents d
		WHERE d.chamber = 'house'
		  AND d.parliament = ANY($2)
		  AND d.last_listed_at = $1
		  AND NOT EXISTS (SELECT 1 FROM register_documents p WHERE p.superseded_by = d.id)`, listedAt, parliaments)
	if err != nil {
		return stats, fmt.Errorf("select arrived rows: %w", err)
	}
	arrived, err := scanSuccessionRows(arrivedRows)
	if err != nil {
		return stats, fmt.Errorf("scan arrived rows: %w", err)
	}

	pairs := pairSuccessors(gone, arrived)

	// Deterministic write order keeps a partial failure reproducible.
	ids := make([]string, 0, len(pairs))
	for g := range pairs {
		ids = append(ids, g)
	}
	sort.Strings(ids)

	tx, err := pool.Begin(ctx)
	if err != nil {
		return stats, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, g := range ids {
		tag, err := tx.Exec(ctx, `
			UPDATE register_documents
			SET superseded_by = $2::uuid, updated_at = now()
			WHERE id = $1::uuid AND superseded_by IS NULL`, g, pairs[g])
		if err != nil {
			return stats, fmt.Errorf("link %s -> %s: %w", g, pairs[g], err)
		}
		stats.Linked += int(tag.RowsAffected())
	}
	if err := tx.Commit(ctx); err != nil {
		return stats, err
	}
	stats.Unpaired = stats.Departed - stats.Linked
	return stats, nil
}

type rowScanner interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
	Close()
}

func scanSuccessionRows(rows rowScanner) ([]successionRow, error) {
	defer rows.Close()
	var out []successionRow
	for rows.Next() {
		var r successionRow
		if err := rows.Scan(&r.ID, &r.Parliament, &r.MemberHint, &r.Division, &r.Seen); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
