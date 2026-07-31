package influence

// The APH Parliamentary Handbook: an identity key, and structured facts.
//
// TWO JOBS, AND THE FIRST ONE MATTERS MORE. `merged_into_id` is 0 of 324 and 28
// people exist twice — `christopher-bowen` (26 statements) and `chris-bowen` (9)
// are one man. §3.3's `person_key` keeps only the FIRST given name, so it cannot
// collapse Chris against Christopher, and both slugs are minted, indexed and
// carrying portraits. The Handbook gives every member a stable PHID, which
// resolves 309 of our 324 rows and collapses all 28 pairs.
//
// THIS MODE DOES NOT MERGE. It writes `aph_phid` and REPORTS the collisions.
// A merge moves an entire declared history onto a named individual and §7.2
// keeps it out of automated paths for that reason; the CHECK added by 000103
// refuses one without a curator and evidence. Detection is a machine job,
// disposition is not.
//
// LICENCE. aph.gov.au is CC BY-NC-ND 4.0. NC matters (this is a paid product)
// and ND forbids adapting the prose, so only FACTS are taken — an occupation
// string is stored as the atom it is, never re-written, and no Handbook prose is
// rendered as prose. Everything ingested is a structured field from an official
// publication, which is what editorial standards §4 permits and all it permits.
//
// handbookapi.aph.gov.au IS NOT WAF-WALLED, unlike www.aph.gov.au — a plain
// request with an honest User-Agent returns 200. Do not reach for the nil-UA
// technique here; it is for the main site.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const handbookIndividualsURL = "https://handbookapi.aph.gov.au/api/individuals"

// handbookSourceKey identifies the provenance of every fact this mode writes.
const handbookSourceKey = "aph-handbook"

// handbookLicence is recorded per fact. CC BY-NC-ND 4.0 is the site deed; §3.1
// records only the vaguer 'commonwealth-parliamentary-material', so the precise
// deed is stored here rather than assumed downstream.
const handbookLicence = "CC BY-NC-ND 4.0 (Parliament of Australia)"

type handbookIndividual struct {
	PHID                 string   `json:"PHID"`
	DisplayName          string   `json:"DisplayName"`
	GivenName            string   `json:"GivenName"`
	FamilyName           string   `json:"FamilyName"`
	PreferredName        string   `json:"PreferredName"`
	Electorate           string   `json:"Electorate"`
	SenateState          string   `json:"SenateState"`
	InCurrentParliament  string   `json:"InCurrentParliament"`
	Occupations          []string `json:"Occupations"`
	SecondaryOccupations []string `json:"SecondaryOccupations"`
	Qualifications       []string `json:"Qualifications"`
}

func fetchHandbookIndividuals(ctx context.Context) ([]handbookIndividual, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, handbookIndividualsURL, nil)
	if err != nil {
		return nil, err
	}
	// An honest, contactable UA. The same courtesy abs.go pays, and enough here.
	req.Header.Set("User-Agent", "shorted-register/1.0 (+https://shorted.com.au; parliamentary handbook)")
	req.Header.Set("Accept", "application/json")

	resp, err := (&http.Client{Timeout: 180 * time.Second}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("handbook fetch: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("handbook returned %d", resp.StatusCode)
	}

	// The endpoint returns either a bare array or an OData {"value": [...]}.
	var envelope struct {
		Value []handbookIndividual `json:"value"`
	}
	body, err := readAllLimited(resp)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(body, &envelope); err == nil && len(envelope.Value) > 0 {
		return envelope.Value, nil
	}
	var bare []handbookIndividual
	if err := json.Unmarshal(body, &bare); err != nil {
		return nil, fmt.Errorf("handbook decode: %w", err)
	}
	return bare, nil
}

// readAllLimited caps the read. The payload is ~7 MB; a 64 MB ceiling stops a
// malformed or hostile response from becoming an OOM in a shared job binary.
func readAllLimited(resp *http.Response) ([]byte, error) {
	const maxBytes = 64 << 20
	buf := make([]byte, 0, 8<<20)
	tmp := make([]byte, 1<<20)
	for {
		n, err := resp.Body.Read(tmp)
		buf = append(buf, tmp[:n]...)
		if len(buf) > maxBytes {
			return nil, fmt.Errorf("handbook response exceeded %d bytes", maxBytes)
		}
		if err != nil {
			if err.Error() == "EOF" {
				return buf, nil
			}
			return buf, nil
		}
	}
}

// handbookRegion is the second half of the match key: a member's division, or a
// senator's state. Same shape as the portrait matcher, for the same reason.
func handbookRegion(h handbookIndividual) string {
	if strings.TrimSpace(h.Electorate) != "" {
		return h.Electorate
	}
	return h.SenateState
}

// matchHandbook pairs our people to Handbook records on surname + region.
// Ambiguity WITHHOLDS: two Handbook records sharing a surname in one division
// across eras cannot be told apart without a date, and picking one would attach
// a stranger's career to a named person.
func matchHandbook(ours []ourPolitician, individuals []handbookIndividual) (map[string]handbookIndividual, int, int) {
	index := map[string][]handbookIndividual{}
	for _, h := range individuals {
		region := handbookRegion(h)
		if h.FamilyName == "" || region == "" || h.PHID == "" {
			continue
		}
		key := photoMatchKey(h.FamilyName) + "|" + photoMatchKey(region)
		index[key] = append(index[key], h)
	}

	matched := map[string]handbookIndividual{}
	ambiguous, missed := 0, 0
	for _, p := range ours {
		region := p.Division
		if p.Chamber == "senate" {
			region = p.StateCode
		}
		if p.Surname == "" || region == "" {
			missed++
			continue
		}
		candidates := index[photoMatchKey(p.Surname)+"|"+photoMatchKey(region)]
		// De-duplicate by PHID: the Handbook carries one record per person per
		// parliament, so the same person legitimately appears many times under
		// one key. Several DISTINCT phids is the ambiguity that matters.
		phids := map[string]handbookIndividual{}
		for _, c := range candidates {
			phids[c.PHID] = c
		}
		switch len(phids) {
		case 1:
			for _, c := range phids {
				matched[p.Slug] = c
			}
		case 0:
			missed++
		default:
			ambiguous++
		}
	}
	return matched, ambiguous, missed
}

// runRegisterHandbook writes aph_phid + structured facts and reports duplicates.
func runRegisterHandbook(ctx context.Context, pool *pgxpool.Pool, dryRun bool) (int, error) {
	ours, err := loadPoliticiansForPhotos(ctx, pool)
	if err != nil {
		return 0, fmt.Errorf("load politicians: %w", err)
	}
	individuals, err := fetchHandbookIndividuals(ctx)
	if err != nil {
		return 0, err
	}
	log.Printf("[register-handbook] %d politicians, %d handbook records", len(ours), len(individuals))

	matched, ambiguous, missed := matchHandbook(ours, individuals)
	log.Printf("[register-handbook] %d matched on surname+region, %d ambiguous, %d unmatched",
		len(matched), ambiguous, missed)

	// THE DUPLICATE REPORT. Two of our slugs resolving to one PHID means one
	// person is published twice with a split history.
	byPHID := map[string][]string{}
	for slug, h := range matched {
		byPHID[h.PHID] = append(byPHID[h.PHID], slug)
	}
	dupes := 0
	for phid, slugs := range byPHID {
		if len(slugs) > 1 {
			dupes++
			log.Printf("[register-handbook] DUPLICATE PHID %s: %s — one person, %d records",
				phid, strings.Join(slugs, " + "), len(slugs))
		}
	}
	if dupes > 0 {
		log.Printf("[register-handbook] %d duplicate identities detected. NOT merged: a merge moves a "+
			"whole declared history onto a named person and needs a curator (000103 CHECK).", dupes)
	}

	if dryRun {
		log.Printf("[register-handbook] DRY RUN — %d phids and their facts would be written", len(matched))
		return len(matched), nil
	}

	written := 0
	for slug, h := range matched {
		if _, err := pool.Exec(ctx,
			`UPDATE politicians SET aph_phid = $2 WHERE slug = $1`, slug, h.PHID); err != nil {
			return written, fmt.Errorf("store phid for %s: %w", slug, err)
		}
		if err := storeHandbookFacts(ctx, pool, slug, h); err != nil {
			return written, err
		}
		written++
	}
	return written, nil
}

// storeHandbookFacts writes the structured atoms.
//
// ONLY OFFICIAL, STRUCTURED FIELDS. Occupations, secondary occupations,
// qualifications and the preferred name — each stored verbatim as the atom the
// Handbook publishes, never re-written (ND) and never assembled into prose.
// There is no biography here and there is not meant to be: editorial standards
// §4 keeps anything that is not an official publication out of scope, and the
// 000103 trigger refuses a field name that looks like private or magnitude data.
func storeHandbookFacts(ctx context.Context, pool *pgxpool.Pool, slug string, h handbookIndividual) error {
	type fact struct {
		field string
		vals  []string
	}
	facts := []fact{
		{"occupation", h.Occupations},
		{"secondary_occupation", h.SecondaryOccupations},
		{"qualification", h.Qualifications},
	}
	// PreferredName is the field that explains every duplicate pair, so it is
	// stored even though it is a single value — a curator merging Chris and
	// Christopher needs to see which one the Handbook calls preferred.
	if strings.TrimSpace(h.PreferredName) != "" {
		facts = append(facts, fact{"preferred_name", []string{h.PreferredName}})
	}

	sourceURL := handbookIndividualsURL + "?$filter=PHID%20eq%20'" + h.PHID + "'"
	for _, f := range facts {
		for i, v := range f.vals {
			v = strings.TrimSpace(v)
			if v == "" {
				continue
			}
			if _, err := pool.Exec(ctx, `
				INSERT INTO politician_profile_facts
					(politician_id, field, ordinal, fact_text, source_key, source_url, source_licence, fetched_at)
				SELECT p.id, $2, $3, $4, $5, $6, $7, now() FROM politicians p WHERE p.slug = $1
				ON CONFLICT (politician_id, field, ordinal, source_key)
				DO UPDATE SET fact_text = EXCLUDED.fact_text, fetched_at = now()`,
				slug, f.field, i, v, handbookSourceKey, sourceURL, handbookLicence); err != nil {
				return fmt.Errorf("store %s[%d] for %s: %w", f.field, i, slug, err)
			}
		}
	}
	return nil
}
