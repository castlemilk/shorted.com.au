package influence

// Portrait photographs, from Wikidata -> Wikimedia Commons.
//
// WHY NOT aph.gov.au. Every sitting member has a portrait there, and §3.1's
// licensing posture rules it out in its own words: extracted FACTS are
// publishable with attribution, the source artefacts must not be mirrored, and
// the GCS bucket is kept private so that "we do not maintain a mirror" is true in
// fact. A portrait is an artefact, and photographs are the likeliest part of that
// corpus to carry a photographer/AUSPIC copyright on top of the Commonwealth's.
// (`aph_mpid`, the natural key to those images, is also 0 of 324 populated.)
//
// COMMONS REQUIRES A FREE LICENCE BY POLICY — it does not host fair-use files.
// That is why this reads Wikidata's P18, which always points at Commons, rather
// than an English Wikipedia page image, where a local fair-use upload is
// possible. Measured on a 20-person sample of enwiki page images: 3 came back
// with an unknown licence. Every P18 target resolves to Commons.
//
// THE MATCH IS A COMPOSITE KEY, NEVER A TEXT SEARCH. A name search over
// Wikipedia matched "Anthony Smith" to Dean Smith — a different sitting member.
// Publishing someone else's face next to a named person's declared interests is
// the worst version of the wrong-fact class this subsystem keeps paying for, so
// the key is surname + electoral division, and ANY ambiguity withholds.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// wikimediaUserAgent is mandatory. The Wikimedia APIs block generic clients and
// ask for a contactable identifier; this is the same courtesy the ABS fetcher
// pays (`abs.go`), for the same reason.
const wikimediaUserAgent = "shorted-register/1.0 (+https://shorted.com.au; portraits for the register of interests)"

// portraitWidth is the rendered size. Requesting a thumbnail rather than the
// original keeps a 12 MB press photo out of a profile page, and Commons
// generates it on their side.
const portraitWidth = 400

// commonsBatchSize is the API's documented cap for a multi-title query.
const commonsBatchSize = 50

// wikidataMember is one parliamentarian as Wikidata holds them.
type wikidataMember struct {
	QID      string
	Label    string
	District string
	FileName string // Commons file, without the "File:" prefix
}

// politicianPhoto is what we store.
type politicianPhoto struct {
	Slug      string
	URL       string
	Licence   string
	Author    string
	SourceURL string
	EntityID  string
}

const wikidataMembersQuery = `
SELECT ?person ?personLabel ?districtLabel ?img WHERE {
  ?person p:P39 ?ps .
  ?ps ps:P39 ?pos .
  VALUES ?pos { wd:Q18912794 wd:Q19795070 }
  ?ps pq:P768 ?district .
  ?person wdt:P18 ?img .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`

func wikimediaGet(ctx context.Context, endpoint string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", wikimediaUserAgent)
	req.Header.Set("Accept", "application/json")

	client := &http.Client{Timeout: 90 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("wikimedia returned %d for %s", resp.StatusCode, endpoint)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// fetchWikidataMembers returns every AU House/Senate member who has BOTH an
// electoral district and a portrait. Both are required by the query itself: a
// record missing either cannot be matched safely, so there is no value in
// carrying it.
func fetchWikidataMembers(ctx context.Context) ([]wikidataMember, error) {
	var payload struct {
		Results struct {
			Bindings []map[string]struct {
				Value string `json:"value"`
			} `json:"bindings"`
		} `json:"results"`
	}
	endpoint := "https://query.wikidata.org/sparql?format=json&query=" + url.QueryEscape(wikidataMembersQuery)
	if err := wikimediaGet(ctx, endpoint, &payload); err != nil {
		return nil, fmt.Errorf("wikidata sparql: %w", err)
	}

	seen := map[string]bool{}
	var out []wikidataMember
	for _, b := range payload.Results.Bindings {
		qid := b["person"].Value
		img := b["img"].Value
		district := b["districtLabel"].Value
		if qid == "" || img == "" || district == "" {
			continue
		}
		// P18 is a Special:FilePath URL; the file name is its last segment.
		name, err := url.PathUnescape(img[strings.LastIndex(img, "/")+1:])
		if err != nil || name == "" {
			continue
		}
		key := qid + "|" + district
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, wikidataMember{
			QID:      qid[strings.LastIndex(qid, "/")+1:],
			Label:    b["personLabel"].Value,
			District: district,
			FileName: name,
		})
	}
	return out, nil
}

// commonsFileMeta is the licence and rendering data for one file.
type commonsFileMeta struct {
	ThumbURL    string
	DescriptionURL string
	Licence     string
	Author      string
}

// fetchCommonsMeta resolves licence, author and a thumbnail for each file.
//
// The licence is READ, never assumed. Commons policy guarantees the file is
// freely licensed, but WHICH licence decides what attribution we owe — CC BY-SA
// and CC0 have different obligations — and the credit line has to come from the
// file itself rather than be invented.
func fetchCommonsMeta(ctx context.Context, files []string) (map[string]commonsFileMeta, error) {
	out := map[string]commonsFileMeta{}
	for start := 0; start < len(files); start += commonsBatchSize {
		end := start + commonsBatchSize
		if end > len(files) {
			end = len(files)
		}
		titles := make([]string, 0, end-start)
		for _, f := range files[start:end] {
			titles = append(titles, "File:"+f)
		}

		endpoint := "https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo" +
			"&iiprop=url|extmetadata&iiurlwidth=" + fmt.Sprint(portraitWidth) +
			"&titles=" + url.QueryEscape(strings.Join(titles, "|"))

		var payload struct {
			Query struct {
				Pages map[string]struct {
					Title     string `json:"title"`
					ImageInfo []struct {
						ThumbURL       string `json:"thumburl"`
						URL            string `json:"url"`
						DescriptionURL string `json:"descriptionurl"`
						ExtMetadata    map[string]struct {
							Value any `json:"value"`
						} `json:"extmetadata"`
					} `json:"imageinfo"`
				} `json:"pages"`
			} `json:"query"`
		}
		if err := wikimediaGet(ctx, endpoint, &payload); err != nil {
			return nil, fmt.Errorf("commons imageinfo: %w", err)
		}

		for _, page := range payload.Query.Pages {
			if len(page.ImageInfo) == 0 {
				continue
			}
			ii := page.ImageInfo[0]
			meta := commonsFileMeta{
				ThumbURL:       firstNonEmptyAlias(ii.ThumbURL, ii.URL),
				DescriptionURL: ii.DescriptionURL,
				Licence:        strings.TrimSpace(extMetaString(ii.ExtMetadata, "LicenseShortName")),
				Author:         cleanCredit(extMetaString(ii.ExtMetadata, "Artist")),
			}
			out[strings.TrimPrefix(page.Title, "File:")] = meta
		}
		// Courtesy pause between batches. Wikimedia asks for serial requests
		// from a single client rather than a burst.
		time.Sleep(250 * time.Millisecond)
	}
	return out, nil
}

func extMetaString(m map[string]struct {
	Value any `json:"value"`
}, key string) string {
	v, ok := m[key]
	if !ok {
		return ""
	}
	s, _ := v.Value.(string)
	return s
}

// cleanCredit turns the HTML credit Commons stores into a plain attribution
// line. The value routinely contains anchors and markup; it is rendered next to
// a named person's face, so it is reduced to text rather than injected.
func cleanCredit(s string) string {
	var b strings.Builder
	depth := 0
	for _, r := range s {
		switch r {
		case '<':
			depth++
		case '>':
			if depth > 0 {
				depth--
			}
		default:
			if depth == 0 {
				b.WriteRune(r)
			}
		}
	}
	out := strings.Join(strings.Fields(b.String()), " ")
	const max = 120
	if len(out) > max {
		out = out[:max] + "…"
	}
	return out
}

// ourPolitician is one of our people, with the division the match needs.
type ourPolitician struct {
	Slug     string
	Surname  string
	Division string
}

func loadPoliticiansForPhotos(ctx context.Context, pool *pgxpool.Pool) ([]ourPolitician, error) {
	// Division lives on the statements, not on the identity row, and a member
	// can appear under more than one over five parliaments — so take the most
	// recent, which is the one their current Wikidata term will name.
	rows, err := pool.Query(ctx, `
		SELECT p.slug, p.surname,
		       COALESCE((
		         SELECT s.declared_division FROM register_statements s
		         WHERE s.politician_id = p.id AND btrim(s.declared_division) <> ''
		         ORDER BY s.parliament DESC NULLS LAST LIMIT 1), '')
		FROM politicians p
		WHERE p.merged_into_id IS NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []ourPolitician
	for rows.Next() {
		var p ourPolitician
		if err := rows.Scan(&p.Slug, &p.Surname, &p.Division); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// photoMatchKey normalises a surname or a division for comparison. Accents and
// punctuation differ between sources ("O'Connor", "O’Connor", "O'connor") and
// the electoral-data prep already recorded that casing mismatch as a landmine
// that silently dropped ~950 suburbs.
func photoMatchKey(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if r >= 'a' && r <= 'z' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// matchPortraits pairs our people to Wikidata records. Returns the matches and
// the count withheld for ambiguity.
func matchPortraits(ours []ourPolitician, members []wikidataMember) (map[string]wikidataMember, int) {
	index := map[string][]wikidataMember{}
	for _, m := range members {
		key := photoMatchKey(lastWord(m.Label)) + "|" + photoMatchKey(m.District)
		index[key] = append(index[key], m)
	}

	matched := map[string]wikidataMember{}
	ambiguous := 0
	for _, p := range ours {
		if p.Division == "" || p.Surname == "" {
			continue
		}
		candidates := index[photoMatchKey(p.Surname)+"|"+photoMatchKey(p.Division)]
		switch {
		case len(candidates) == 1:
			matched[p.Slug] = candidates[0]
		case len(candidates) > 1:
			// Two people share a surname in one division — a father and son, or
			// a recycled name across eras. WITHHOLD. There is no tie-break here
			// that is not a guess about which face belongs to which record.
			ambiguous++
		}
	}
	return matched, ambiguous
}

func lastWord(s string) string {
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return ""
	}
	return fields[len(fields)-1]
}

// runRegisterPhotos resolves and stores portraits.
func runRegisterPhotos(ctx context.Context, pool *pgxpool.Pool, dryRun bool) (int, error) {
	ours, err := loadPoliticiansForPhotos(ctx, pool)
	if err != nil {
		return 0, fmt.Errorf("load politicians: %w", err)
	}
	members, err := fetchWikidataMembers(ctx)
	if err != nil {
		return 0, err
	}
	log.Printf("[register-photos] %d politicians, %d Wikidata records with a district and a portrait",
		len(ours), len(members))

	matched, ambiguous := matchPortraits(ours, members)
	log.Printf("[register-photos] %d matched on surname+division, %d withheld as ambiguous",
		len(matched), ambiguous)
	if len(matched) == 0 {
		return 0, nil
	}

	files := make([]string, 0, len(matched))
	seen := map[string]bool{}
	for _, m := range matched {
		if !seen[m.FileName] {
			seen[m.FileName] = true
			files = append(files, m.FileName)
		}
	}
	meta, err := fetchCommonsMeta(ctx, files)
	if err != nil {
		return 0, err
	}

	var photos []politicianPhoto
	skippedNoLicence := 0
	for slug, m := range matched {
		md, ok := meta[m.FileName]
		if !ok || md.ThumbURL == "" {
			continue
		}
		// NO LICENCE, NO PHOTO. The database CHECK enforces this too, but
		// failing here keeps the reason legible: we could not establish the
		// terms, so we do not publish the image.
		if md.Licence == "" || md.DescriptionURL == "" {
			skippedNoLicence++
			continue
		}
		photos = append(photos, politicianPhoto{
			Slug:      slug,
			URL:       md.ThumbURL,
			Licence:   md.Licence,
			Author:    md.Author,
			SourceURL: md.DescriptionURL,
			EntityID:  m.QID,
		})
	}
	if skippedNoLicence > 0 {
		log.Printf("[register-photos] %d skipped: licence could not be established", skippedNoLicence)
	}

	if dryRun {
		log.Printf("[register-photos] DRY RUN %d portraits resolved", len(photos))
		for i, p := range photos {
			if i >= 3 {
				break
			}
			log.Printf("[register-photos]   %-28s %s (%s)", p.Slug, p.Licence, p.Author)
		}
		return len(photos), nil
	}

	written := 0
	for _, p := range photos {
		if _, err := pool.Exec(ctx, `
			UPDATE politicians
			SET photo_url = $2, photo_licence = $3, photo_author = $4,
			    photo_source_url = $5, photo_entity_id = $6, photo_fetched_at = now()
			WHERE slug = $1`,
			p.Slug, p.URL, p.Licence, p.Author, p.SourceURL, p.EntityID); err != nil {
			return written, fmt.Errorf("store portrait for %s: %w", p.Slug, err)
		}
		written++
	}
	return written, nil
}
