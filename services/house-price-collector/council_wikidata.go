package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Council identity from Wikidata (CC0): each council's QID and official
// website (P856), joined on the ASGS 2021 LGA code (P10112, 'LGA10050').
// Only identity comes from here — coordinates are computed from ABS geometry
// by join-lga-mb.py, and nothing from Wikipedia prose is used.
//
// The mode reads a COMMITTED snapshot (data/wikidata-lga.json) so every run,
// and every environment, writes the same values. WIKIDATA_REFRESH=true
// re-queries the SPARQL endpoint first and rewrites the snapshot, which is
// then reviewed and committed like any other data change.

const (
	wikidataSource   = "wikidata_lga"
	wikidataLicence  = "CC0-1.0"
	wikidataEndpoint = "https://query.wikidata.org/sparql"
	// One row per (item, code, website): a council with two P856 values
	// returns two rows, resolved by pickWebsite.
	wikidataQuery = `SELECT ?item ?code ?website WHERE {
  ?item wdt:P10112 ?code .
  FILTER(STRSTARTS(?code, "LGA"))
  OPTIONAL { ?item wdt:P856 ?website }
}`
	wikidataMinCouncils = 500
)

// wikidataSnapshot is the committed file. Keys of Councils are lga_code24.
type wikidataSnapshot struct {
	Source    string                     `json:"source"`
	Licence   string                     `json:"licence"`
	FetchedAt string                     `json:"fetchedAt"`
	Query     string                     `json:"query"`
	Councils  map[string]wikidataCouncil `json:"councils"`
}

type wikidataCouncil struct {
	QID     string `json:"qid"`
	Website string `json:"website,omitempty"`
}

var (
	wikidataQIDRe  = regexp.MustCompile(`^Q[1-9][0-9]*$`)
	wikidataCodeRe = regexp.MustCompile(`^LGA([0-9]{5})$`)
)

func wikidataSnapshotPath() string {
	if p := strings.TrimSpace(os.Getenv("WIKIDATA_LGA_SNAPSHOT")); p != "" {
		return p
	}
	return filepath.Join("house-price-collector", "data", "wikidata-lga.json")
}

// sparqlResults is the slice of the SPARQL JSON results format we read.
type sparqlResults struct {
	Results struct {
		Bindings []map[string]struct {
			Value string `json:"value"`
		} `json:"bindings"`
	} `json:"results"`
}

// parseWikidataLGA turns SPARQL results into a snapshot keyed by lga_code24.
// A code claimed by two items keeps the lower QID (deterministic) and is
// reported; a website that is not an absolute http(s) URL is dropped.
func parseWikidataLGA(raw []byte) (map[string]wikidataCouncil, []string, error) {
	var res sparqlResults
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, nil, fmt.Errorf("wikidata SPARQL results: %w", err)
	}
	type cand struct {
		qid      string
		websites []string
	}
	byCode := map[string]map[string]*cand{}
	for _, b := range res.Results.Bindings {
		m := wikidataCodeRe.FindStringSubmatch(b["code"].Value)
		qid := strings.TrimPrefix(b["item"].Value, "http://www.wikidata.org/entity/")
		if m == nil || !wikidataQIDRe.MatchString(qid) {
			continue
		}
		code := m[1]
		if to, ok := lgaRecode[code]; ok {
			code = to // Merri-bek is stored under its LGA_2021 code, LGA25250
		}
		if byCode[code] == nil {
			byCode[code] = map[string]*cand{}
		}
		c := byCode[code][qid]
		if c == nil {
			c = &cand{qid: qid}
			byCode[code][qid] = c
		}
		if w := b["website"].Value; validWebsite(w) {
			c.websites = append(c.websites, w)
		}
	}
	out := map[string]wikidataCouncil{}
	var notes []string
	for code, items := range byCode {
		qids := make([]string, 0, len(items))
		for q := range items {
			qids = append(qids, q)
		}
		sort.Slice(qids, func(i, j int) bool { return qidLess(qids[i], qids[j]) })
		if len(qids) > 1 {
			notes = append(notes, fmt.Sprintf("%s claimed by %v, kept %s", code, qids, qids[0]))
		}
		c := items[qids[0]]
		out[code] = wikidataCouncil{QID: c.qid, Website: pickWebsite(c.websites)}
	}
	sort.Strings(notes)
	if len(out) == 0 {
		return nil, nil, fmt.Errorf("wikidata: no LGA items in results")
	}
	return out, notes, nil
}

func qidLess(a, b string) bool {
	if len(a) != len(b) {
		return len(a) < len(b)
	}
	return a < b
}

func validWebsite(s string) bool {
	u, err := url.Parse(strings.TrimSpace(s))
	return err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != ""
}

// pickWebsite chooses one of several official websites: https over http,
// then the shortest (the bare domain over a deep link), then lexical.
func pickWebsite(ws []string) string {
	if len(ws) == 0 {
		return ""
	}
	sort.Slice(ws, func(i, j int) bool {
		hi, hj := strings.HasPrefix(ws[i], "https://"), strings.HasPrefix(ws[j], "https://")
		if hi != hj {
			return hi
		}
		if len(ws[i]) != len(ws[j]) {
			return len(ws[i]) < len(ws[j])
		}
		return ws[i] < ws[j]
	})
	return ws[0]
}

// refreshWikidataSnapshot queries Wikidata and rewrites the committed snapshot.
func refreshWikidataSnapshot(ctx context.Context, path string, now time.Time) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		wikidataEndpoint+"?format=json&query="+url.QueryEscape(wikidataQuery), nil)
	if err != nil {
		return err
	}
	// Wikidata's policy asks for a descriptive UA with a contact URL.
	req.Header.Set("User-Agent", absUA)
	req.Header.Set("Accept", "application/sparql-results+json")
	resp, err := (&http.Client{Timeout: 90 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("wikidata SPARQL: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("wikidata SPARQL: HTTP %d: %.200s", resp.StatusCode, raw)
	}
	snap, err := buildWikidataSnapshot(raw, now)
	if err != nil {
		return err
	}
	b, err := json.MarshalIndent(snap, "", " ") // map keys marshal sorted: a stable diff
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o644)
}

// buildWikidataSnapshot parses SPARQL results into the snapshot to commit,
// refusing a result too small to be the whole country: a partial answer (a
// timeout, a changed property) would otherwise overwrite a good snapshot.
func buildWikidataSnapshot(raw []byte, now time.Time) (wikidataSnapshot, error) {
	councils, notes, err := parseWikidataLGA(raw)
	if err != nil {
		return wikidataSnapshot{}, err
	}
	for _, n := range notes {
		log.Printf("[wikidata-lga] %s", n)
	}
	if len(councils) < wikidataMinCouncils {
		return wikidataSnapshot{}, fmt.Errorf("wikidata returned only %d councils (< %d): refusing to overwrite the snapshot", len(councils), wikidataMinCouncils)
	}
	return wikidataSnapshot{
		Source: wikidataEndpoint, Licence: wikidataLicence,
		FetchedAt: now.UTC().Format("2006-01-02"), Query: wikidataQuery, Councils: councils,
	}, nil
}

func readWikidataSnapshot(path string) (wikidataSnapshot, error) {
	var snap wikidataSnapshot
	if err := readJSONFile(path, &snap); err != nil {
		return snap, err
	}
	if snap.Licence != wikidataLicence {
		return snap, fmt.Errorf("%s: licence %q, want %s", path, snap.Licence, wikidataLicence)
	}
	return snap, nil
}

// runWikidataLGA writes each council's QID + website from the snapshot.
func runWikidataLGA(ctx context.Context, pool *pgxpool.Pool) error {
	path := wikidataSnapshotPath()
	if envBool("WIKIDATA_REFRESH", false) {
		if err := refreshWikidataSnapshot(ctx, path, time.Now()); err != nil {
			return recordLGARun(ctx, pool, wikidataSource, nil, 0, err)
		}
		log.Printf("[wikidata-lga] snapshot refreshed → %s (review + commit it)", path)
	}
	snap, err := readWikidataSnapshot(path)
	if err != nil {
		return recordLGARun(ctx, pool, wikidataSource, nil, 0, err)
	}
	ix, err := loadLGAIndex(ctx, pool)
	if err != nil {
		return recordLGARun(ctx, pool, wikidataSource, nil, 0, err)
	}
	codes, err := wikidataWrites(snap, ix)
	if err != nil {
		return recordLGARun(ctx, pool, wikidataSource, nil, 0, err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return recordLGARun(ctx, pool, wikidataSource, nil, 0, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	batch := &pgx.Batch{}
	for _, code := range codes {
		c := snap.Councils[code]
		batch.Queue(`UPDATE lga SET wikidata_qid = $2, website = NULLIF($3, ''), fetched_at = now() WHERE lga_code24 = $1`,
			code, c.QID, c.Website)
	}
	if err := execBatch(ctx, tx, batch, len(codes)); err != nil {
		return recordLGARun(ctx, pool, wikidataSource, nil, 0, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return recordLGARun(ctx, pool, wikidataSource, nil, 0, err)
	}
	var fetched *time.Time
	if t, err := time.Parse("2006-01-02", snap.FetchedAt); err == nil {
		fetched = &t
	}
	return recordLGARun(ctx, pool, wikidataSource, fetched, len(codes), nil)
}

// wikidataWrites is the set of councils runWikidataLGA writes, refused when
// fewer than wikidataMinCouncils match: the snapshot and the dimension have
// drifted apart (a recode, a regenerated dimension), and writing a few would
// hide that.
func wikidataWrites(snap wikidataSnapshot, ix lgaIndex) ([]string, error) {
	codes, missing, unknown := wikidataMatch(snap.Councils, ix)
	log.Printf("[wikidata-lga] snapshot %s: %d councils matched; no Wikidata item for %v; not in dimension %v",
		snap.FetchedAt, len(codes), missing, unknown)
	if len(codes) < wikidataMinCouncils {
		return nil, fmt.Errorf("only %d councils matched the Wikidata snapshot (< %d)", len(codes), wikidataMinCouncils)
	}
	return codes, nil
}

// wikidataMatch returns the snapshot codes to write (real councils in the
// dimension, sorted), the real councils the snapshot lacks, and snapshot codes
// the dimension does not hold.
func wikidataMatch(councils map[string]wikidataCouncil, ix lgaIndex) (codes, missing, unknown []string) {
	for code := range councils {
		switch {
		case !ix.has(code):
			unknown = append(unknown, code)
		case ix.geographic(code):
			codes = append(codes, code)
		}
	}
	for code := range ix.kind {
		if _, ok := councils[code]; !ok && ix.kind[code] == lgaKindCouncil {
			missing = append(missing, code)
		}
	}
	sort.Strings(codes)
	sort.Strings(missing)
	sort.Strings(unknown)
	return codes, missing, unknown
}
