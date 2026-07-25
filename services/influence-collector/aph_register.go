package main

// Discovery for the Registers of Members' and Senators' Interests (aph.gov.au).
//
// This file only DISCOVERS documents and writes the manifest. Fetching bytes is
// aph_fetch.go; parsing PDFs happens in services/report-extractor (Go never
// parses a PDF here).
//
// # The User-Agent situation (read before changing any header)
//
// APH sits behind a WAF that ALLOWLISTS real-browser User-Agent tokens and 403s
// everything else. Measured 2026-07-25:
//
//	no User-Agent header at all ............................ 200
//	Chrome UA string ...................................... 200
//	"shorted-data/1.0 (+https://shorted.com.au)" .......... 403
//	"Mozilla/5.0" ......................................... 403
//	"Mozilla/5.0 (compatible; shorted-politics/1.0; +...)" . 403
//
// So the honest-identifier convention that works for ABS (absdata.UserAgent)
// FAILS here, and the only non-deceptive option that works is to send no
// User-Agent at all and identify ourselves out-of-band via From and a contact
// header. We deliberately do NOT spoof a browser token: that would be WAF
// evasion, which this package refuses to do (see errSourceUnavailable in
// lobbyists.go — a block is a signal, never something to route around).
//
// robots.txt is `Allow: /` with four Disallow paths (events calendar, watch
// parliament), none of which touch the register, and no Crawl-delay.
//
// # Identity
//
// The listing rows are a real HTML table:
//
//	<tr>
//	  <td class="date">9 July 2026</td>
//	  <td>Albanese, Hon Anthony, Member for Grayndler, NSW </td>
//	  <td class="format"><a href="/-/media/…/Albanese_48P.pdf"><img title="4948KB"></a></td>
//	</tr>
//
// The anchor text is EMPTY (it wraps an <img>), so the member name comes from
// the sibling cell. Filenames are irregular (Scrymgour.pdf, Leeser46P.pdf,
// ChesterD_48P.pdf, Dai_Le_48P.pdf, Llewellyn_OBrien48P.pdf) and must never be
// used to derive identity or to construct URLs.

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
)

const (
	registerSource        = "aph-register-of-interests"
	registerSourceLicence = "commonwealth-parliamentary-material"

	aphBase           = "https://www.aph.gov.au"
	houseRegisterPath = "/Senators_and_Members/Members/Register"
	senateVolumesPath = "/Parliamentary_Business/Committees/Senate/Senators_Interests/Tabled_volumes"

	// Out-of-band self-identification, since we cannot send a User-Agent.
	registerContactEmail = "ops@shorted.com.au"
	registerContactURL   = "https://shorted.com.au"

	// The 44th Parliament opened 2013-11-12. Senate volumes are tabled by
	// lodgement window rather than parliament, so we keep any volume whose
	// window ends on or after the 44th's first sitting-adjacent tabling.
	registerEarliestSenateTabling = "2013-06-01"
)

// housePreviousParliamentPaths maps a parliament number to its listing page.
// 48P is the live Register page; 44-47P live under Previous_Parliaments with
// INCONSISTENT slugs, which is exactly why they are enumerated rather than
// derived.
var housePreviousParliamentPaths = map[int]string{
	48: houseRegisterPath,
	47: houseRegisterPath + "/Previous_Parliaments/47th_Parliament_Register_of_Members_interests",
	46: houseRegisterPath + "/Previous_Parliaments/46P_Members_Interest_Statements",
	45: houseRegisterPath + "/Previous_Parliaments/45P_Members_Interest_Statements",
	44: houseRegisterPath + "/Previous_Parliaments/44P_Members_Interest_Statements",
}

// houseParliaments is the deterministic iteration order (newest first) so a
// -register-limit run always covers the most current parliament.
var houseParliaments = []int{48, 47, 46, 45, 44}

// RegisterDocument is one physical PDF discovered on a listing page.
type RegisterDocument struct {
	SourceURL       string
	ListingURL      string
	Chamber         string // "house" | "senate"
	Parliament      int    // 44..48; 0 for Senate volumes
	MemberHint      string // raw listing name cell
	DivisionHint    string
	StateHint       string
	LastUpdatedAt   *time.Time
	ListedSizeLabel string
	VolumeLabel     string
	VolumeOrdinal   int
	TabledFrom      *time.Time
	TabledTo        *time.Time
	StatementsOnly  *bool
}

// newAPHRequest builds a request that sends NO User-Agent (see the file header)
// while still identifying us via From and a contact header.
//
// net/http substitutes "Go-http-client/1.1" only when the User-Agent key is
// ABSENT — and that default is itself 403'd by APH (measured). Assigning nil to
// the map key suppresses the header entirely. Setting it to "" also works, but
// nil states the intent unambiguously and cannot be mistaken for an accidental
// empty value.
//
// Verified live 2026-07-25 against the House listing page:
//
//	Go default (header untouched) .......... 403
//	Header.Set("User-Agent", "") ........... 200
//	Header["User-Agent"] = nil ............. 200
func newAPHRequest(ctx context.Context, rawURL string) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header["User-Agent"] = nil
	req.Header.Set("From", registerContactEmail)
	req.Header.Set("X-Crawler-Contact", registerContactURL)
	req.Header.Set("Accept-Language", "en-AU,en;q=0.9")
	return req, nil
}

func newAPHClient() *http.Client {
	return &http.Client{
		// Senate volumes in scope reach ~33MB; the timeout covers a slow tail
		// without being an excuse to hammer.
		Timeout: 300 * time.Second,
		Transport: &http.Transport{
			MaxIdleConnsPerHost: 2,
		},
	}
}

func fetchAPHPage(ctx context.Context, client *http.Client, pageURL string) (*goquery.Document, error) {
	req, err := newAPHRequest(ctx, pageURL)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "text/html,application/xhtml+xml")

	resp, err := client.Do(req)
	if err != nil {
		return nil, &errSourceUnavailable{SourceKey: registerSource, Reason: fmt.Sprintf("fetch %s: %v", pageURL, err)}
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode == http.StatusForbidden {
		// A 403 means the WAF policy changed. That is a real signal and gets its
		// own alarm; it is never retried or routed around.
		return nil, &errSourceUnavailable{SourceKey: registerSource, Reason: fmt.Sprintf("%s returned HTTP 403 (WAF policy change?)", pageURL)}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 400 {
		return nil, fmt.Errorf("fetch %s: HTTP %d", pageURL, resp.StatusCode)
	}

	doc, err := goquery.NewDocumentFromReader(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", pageURL, err)
	}
	return doc, nil
}

// ---------------------------------------------------------------------------
// House
// ---------------------------------------------------------------------------

// houseMemberPDFRe matches a member statement PDF and nothing else.
//
// Requiring the PARLIAMENT FOLDER (48p, 47P, …) is load-bearing: the listing
// pages also link non-member PDFs under the same Register/ prefix, e.g.
// .../Register/Explanatory_notes/Explanatory_Notes___Booklet_1.pdf. A prefix-only
// filter silently ingests those as if they were members.
//
// The folder's case is inconsistent across parliaments ("48p" but "47P"), hence
// the case-insensitive flag.
var houseMemberPDFRe = regexp.MustCompile(`(?i)/32_Members/Register/(\d{2})p/[^/]+/[^/]+\.pdf$`)

// discoverHouseRegisterDocuments walks the five House listing pages.
func discoverHouseRegisterDocuments(ctx context.Context, client *http.Client) ([]RegisterDocument, error) {
	var out []RegisterDocument
	for _, parliament := range houseParliaments {
		pageURL := aphBase + housePreviousParliamentPaths[parliament]
		doc, err := fetchAPHPage(ctx, client, pageURL)
		if err != nil {
			return nil, fmt.Errorf("parliament %d: %w", parliament, err)
		}
		docs, err := parseHouseListing(doc, pageURL, parliament)
		if err != nil {
			return nil, fmt.Errorf("parliament %d: %w", parliament, err)
		}
		if len(docs) == 0 {
			// A listing that silently yields nothing means the markup changed.
			// Treat it as a hard failure rather than quietly under-collecting.
			return nil, fmt.Errorf("parliament %d: listing %s produced 0 documents (markup drift?)", parliament, pageURL)
		}
		out = append(out, docs...)
	}
	return out, nil
}

func parseHouseListing(doc *goquery.Document, pageURL string, parliament int) ([]RegisterDocument, error) {
	base, err := url.Parse(pageURL)
	if err != nil {
		return nil, err
	}

	seen := make(map[string]bool)
	var out []RegisterDocument

	doc.Find("tr").Each(func(_ int, row *goquery.Selection) {
		anchor := row.Find("a[href]").FilterFunction(func(_ int, sel *goquery.Selection) bool {
			href, _ := sel.Attr("href")
			return houseMemberPDFRe.MatchString(strings.TrimSpace(href))
		}).First()
		if anchor.Length() == 0 {
			return
		}
		href, _ := anchor.Attr("href")
		resolved, err := base.Parse(strings.TrimSpace(href))
		if err != nil {
			return
		}
		sourceURL := resolved.String()
		if seen[sourceURL] {
			return
		}
		seen[sourceURL] = true

		rd := RegisterDocument{
			SourceURL:  sourceURL,
			ListingURL: pageURL,
			Chamber:    "house",
			Parliament: parliament,
		}
		if title, ok := anchor.Find("img[title]").First().Attr("title"); ok {
			rd.ListedSizeLabel = strings.TrimSpace(title)
		}

		row.Find("td").Each(func(_ int, cell *goquery.Selection) {
			text := strings.Join(strings.Fields(cell.Text()), " ")
			if text == "" {
				return
			}
			switch {
			case cell.HasClass("date"):
				if t, ok := parseAPHDate(text); ok {
					rd.LastUpdatedAt = &t
				}
			case cell.HasClass("format"):
				// the anchor cell; nothing to read
			case rd.MemberHint == "":
				rd.MemberHint = text
			}
		})

		rd.DivisionHint, rd.StateHint = parseHouseNameCell(rd.MemberHint)
		out = append(out, rd)
	})

	return out, nil
}

// memberForRe matches the division phrase. The listing is hand-maintained and
// its wording drifts, so all of these real forms must parse:
//
//	"Member for Chifley"            the normal case
//	"Former Member for North Sydney" members who left mid-parliament (44P)
//	"for Canning"                   "Member" simply missing (Hastie, 44P)
//	"Member Eden-Monaro NSW"        no "for", and the state is not comma-split
//
// Getting these right matters beyond tidiness: division is the join key to
// suburb_demographics.federal_division, which is what powers "suburbs this
// member represents".
var memberForRe = regexp.MustCompile(`(?i)^(?:former\s+)?(?:member\s+)?(?:for\s+)?(.+)$`)

// memberPhraseRe decides whether a comma-part is a division phrase at all, so
// an honorific ("The Hon Edham") is never mistaken for a seat.
var memberPhraseRe = regexp.MustCompile(`(?i)^(?:former\s+)?(?:member\b|for\b)`)

var stateTokenRe = regexp.MustCompile(`(?i)^(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)$`)

// footnoteMarkers are appended to the state token on rows that carry a table
// footnote — both superscript ("NSW¹", "TAS³", "SA⁴") and letter forms
// ("SAC" = SA + note C, "WAW" = WA + note W).
const footnoteMarkers = "¹²³⁴⁵⁶⁷⁸⁹⁰0123456789*†‡§.,"

// normaliseStateToken recovers a state code from a footnote-suffixed token.
//
// Order matters: the full token is tested FIRST, so a real three-letter state
// (NSW, QLD, TAS, ACT, VIC) is never truncated to a two-letter one. Only after
// that does it try dropping a single trailing letter, which can therefore only
// ever rescue the two-letter codes SA, WA and NT.
func normaliseStateToken(raw string) (string, bool) {
	up := strings.ToUpper(strings.TrimSpace(raw))
	up = strings.TrimRight(up, footnoteMarkers)
	if stateTokenRe.MatchString(up) {
		return up, true
	}
	if len(up) > 2 {
		if cand := up[:len(up)-1]; stateTokenRe.MatchString(cand) {
			return cand, true
		}
	}
	return "", false
}

// trailingStateRe peels a state token off the end of a division phrase, for the
// rows where it was never comma-separated ("Member Eden-Monaro NSW").
var trailingStateRe = regexp.MustCompile(`(?i)\s+(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)$`)

// parseHouseNameCell pulls the division and state out of a listing name cell.
//
// Observed shapes (note the state is sometimes absent entirely):
//
//	"Albanese, Hon Anthony, Member for Grayndler, NSW"
//	"O'Brien, Mr Llew, Member for Wide Bay, QLD"
//	"Chester, Mr Darren, Member for Gippsland"
//	"Hockey, The Hon Joe, Former Member for North Sydney, NSW"
//	"McBain, Ms Kristy , Member Eden-Monaro NSW"
//
// The surname/given split is deliberately left to the identity resolver — this
// only extracts the two hint fields the manifest needs.
func parseHouseNameCell(cell string) (division, state string) {
	for part := range strings.SplitSeq(cell, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if s, ok := normaliseStateToken(part); ok {
			state = s
			continue
		}
		if division != "" || !memberPhraseRe.MatchString(part) {
			continue
		}
		m := memberForRe.FindStringSubmatch(part)
		if m == nil {
			continue
		}
		candidate := strings.TrimSpace(m[1])
		// "Member Eden-Monaro NSW" carries the state inside the same phrase.
		if sm := trailingStateRe.FindStringSubmatch(candidate); sm != nil {
			if state == "" {
				state = strings.ToUpper(sm[1])
			}
			candidate = strings.TrimSpace(trailingStateRe.ReplaceAllString(candidate, ""))
		}
		division = candidate
	}
	return division, state
}

// ---------------------------------------------------------------------------
// Senate
// ---------------------------------------------------------------------------

// senateMediaRe matches the Sitecore media hrefs used on the volumes page. They
// appear in several relative forms — "-/media/GUID.ashx", "~/media/GUID.ashx"
// and "/-/media/GUID.ashx" — all of which resolve to the same absolute
// "/-/media/GUID.ashx". Resolving the bare "-/media/…" form against the page URL
// would wrongly produce ".../Senators_Interests/-/media/…", so these are
// normalised explicitly rather than via base.Parse.
var senateMediaRe = regexp.MustCompile(`(?i)[~-]?/?media/([0-9A-F]{32})\.ashx`)

func normaliseSenateMediaURL(href string) (string, bool) {
	m := senateMediaRe.FindStringSubmatch(href)
	if m == nil {
		return "", false
	}
	return aphBase + "/-/media/" + strings.ToUpper(m[1]) + ".ashx", true
}

// discoverSenateRegisterVolumes walks the tabled-volumes listing.
//
// Unlike the House, one document covers MANY senators: volumes are tabled per
// lodgement window, and post-election windows are split A-L / M-Z into Volume 1
// and Volume 2. Volumes older than the 44th Parliament are skipped.
func discoverSenateRegisterVolumes(ctx context.Context, client *http.Client) ([]RegisterDocument, error) {
	pageURL := aphBase + senateVolumesPath
	doc, err := fetchAPHPage(ctx, client, pageURL)
	if err != nil {
		return nil, err
	}
	docs, err := parseSenateListing(doc, pageURL)
	if err != nil {
		return nil, err
	}
	if len(docs) == 0 {
		return nil, fmt.Errorf("senate volumes listing %s produced 0 documents (markup drift?)", pageURL)
	}
	return docs, nil
}

func parseSenateListing(doc *goquery.Document, pageURL string) ([]RegisterDocument, error) {
	cutoff, err := time.Parse("2006-01-02", registerEarliestSenateTabling)
	if err != nil {
		return nil, err
	}

	seen := make(map[string]bool)
	var out []RegisterDocument

	doc.Find("a[href]").Each(func(_ int, sel *goquery.Selection) {
		href, _ := sel.Attr("href")
		sourceURL, ok := normaliseSenateMediaURL(href)
		if !ok || seen[sourceURL] {
			return
		}
		label := strings.Join(strings.Fields(sel.Text()), " ")
		if !strings.Contains(strings.ToLower(label), "lodged") {
			return
		}
		seen[sourceURL] = true

		rd := RegisterDocument{
			SourceURL:   sourceURL,
			ListingURL:  pageURL,
			Chamber:     "senate",
			VolumeLabel: label,
		}
		rd.TabledFrom, rd.TabledTo, rd.VolumeOrdinal, rd.StatementsOnly = parseSenateVolumeLabel(label)

		// Keep anything whose window ENDS at or after the cutoff. A volume with
		// no parseable end date is kept rather than silently dropped.
		if rd.TabledTo != nil && rd.TabledTo.Before(cutoff) {
			return
		}
		out = append(out, rd)
	})

	return out, nil
}

// senateDateRe matches "1 July 2025" and the year-less "1 July" that appears in
// labels like "lodged between 1 July and 31 August 2014".
var senateDateRe = regexp.MustCompile(`(?i)\b(\d{1,2})\s+([A-Za-z]{3,9})(?:\s+(\d{4}))?\b`)

// senateVolumeRe matches both "- Volume 1" and the older "Volume - 1".
var senateVolumeRe = regexp.MustCompile(`(?i)volume\s*-?\s*(\d)|-\s*volume\s*(\d)`)

var monthNames = map[string]time.Month{
	"jan": time.January, "feb": time.February, "mar": time.March,
	"apr": time.April, "may": time.May, "jun": time.June,
	"jul": time.July, "aug": time.August, "sep": time.September,
	"oct": time.October, "nov": time.November, "dec": time.December,
}

// parseSenateVolumeLabel reads a tabled-volume link label.
//
// Real observed shapes, including the messy ones:
//
//	"lodged between 1 July 2025 and 19 August 2025 - Volume 1 (PDF 2MB)"
//	"lodged between 20 August 2025 and 31 December 2025 (PDF 5MB)"
//	"lodged between 1 July and 31 August 2014 - Volume 1 (PDF 17.957Kb)"   <- no year on the first date
//	"lodged between 1 January 2021 to 30 June 2021 (PDF 1.7Mb)"            <- "to", not "and"
//	"lodged by 5 August 2011 (statements only) - Volume 1 (PDF 7.9Mb)"     <- open start
//	"lodged between 20 June 2003 and 27 NoveMber 2003 (PDF 37Mb)"          <- source typo
//	"lodged by 2 June 1994 Volume - 1 (PDF 24Mb)"                          <- older volume form
func parseSenateVolumeLabel(label string) (from, to *time.Time, volume int, statementsOnly *bool) {
	// Strip the trailing size annotation so "(PDF 2MB)" can't be read as a date.
	clean := label
	if i := strings.LastIndex(clean, "(PDF"); i >= 0 {
		clean = clean[:i]
	}

	matches := senateDateRe.FindAllStringSubmatch(clean, -1)
	dates := make([]time.Time, 0, len(matches))
	type pending struct {
		day   int
		month time.Month
		idx   int
	}
	var yearless []pending

	for _, m := range matches {
		day, err := strconv.Atoi(m[1])
		if err != nil {
			continue
		}
		month, ok := monthNames[strings.ToLower(m[2])[:3]]
		if !ok {
			continue
		}
		if m[3] == "" {
			yearless = append(yearless, pending{day: day, month: month, idx: len(dates)})
			dates = append(dates, time.Time{}) // placeholder, filled below
			continue
		}
		year, err := strconv.Atoi(m[3])
		if err != nil {
			continue
		}
		dates = append(dates, time.Date(year, month, day, 0, 0, 0, 0, time.UTC))
	}

	// Borrow the year for year-less dates from the first dated entry after them
	// ("1 July and 31 August 2014" -> 1 July 2014).
	if len(yearless) > 0 {
		var fallbackYear int
		for _, d := range dates {
			if !d.IsZero() {
				fallbackYear = d.Year()
				break
			}
		}
		if fallbackYear != 0 {
			for _, p := range yearless {
				if p.idx < len(dates) {
					dates[p.idx] = time.Date(fallbackYear, p.month, p.day, 0, 0, 0, 0, time.UTC)
				}
			}
		}
	}

	// Drop any placeholder we could not fill.
	filled := dates[:0]
	for _, d := range dates {
		if !d.IsZero() {
			filled = append(filled, d)
		}
	}
	dates = filled

	lower := strings.ToLower(clean)
	switch {
	case strings.Contains(lower, "lodged by") && len(dates) >= 1:
		// Open start: everything lodged up to this date.
		to = &dates[len(dates)-1]
	case len(dates) >= 2:
		from = &dates[0]
		to = &dates[len(dates)-1]
	case len(dates) == 1:
		to = &dates[0]
	}

	if m := senateVolumeRe.FindStringSubmatch(clean); m != nil {
		for _, g := range m[1:] {
			if g == "" {
				continue
			}
			if v, err := strconv.Atoi(g); err == nil {
				volume = v
				break
			}
		}
	}

	switch {
	case strings.Contains(lower, "statements only"):
		t := true
		statementsOnly = &t
	case strings.Contains(lower, "alterations only"):
		f := false
		statementsOnly = &f
	}

	return from, to, volume, statementsOnly
}

// missingSpaceRe repairs the hand-typed date cells that lost their separator,
// e.g. the 46th-Parliament Husic row reads "1April 2020".
var missingSpaceRe = regexp.MustCompile(`(\d)([A-Za-z])`)

// parseAPHDate reads the listing's "9 July 2026" date cell.
func parseAPHDate(s string) (time.Time, bool) {
	s = strings.Join(strings.Fields(s), " ")
	s = missingSpaceRe.ReplaceAllString(s, "$1 $2")
	for _, layout := range []string{"2 January 2006", "02 January 2006", "2 Jan 2006", "2 January, 2006"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}
