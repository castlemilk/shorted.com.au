package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/PuerkitoBio/goquery"
)

// houseListingFixture reproduces the real markup verbatim, including the shapes
// that break naive parsers:
//   - the anchor text is EMPTY (it wraps an <img>), so the name must come from
//     the sibling cell
//   - filenames are irregular (Scrymgour.pdf has no parliament suffix,
//     Llewellyn_OBrien48P.pdf has no underscore before 48P)
//   - Chester's row carries NO state token
//   - O'Brien's surname contains an apostrophe
const houseListingFixture = `<html><body><table><thead><tr><th>Date</th></tr></thead><tbody>
<tr>
  <td class="date">9 July 2026</td>
  <td>Albanese, Hon Anthony, Member for Grayndler, NSW </td>
  <td class="format"> <a href="/-/media/03_Senators_and_Members/32_Members/Register/48p/AB/Albanese_48P.pdf"><img title="4948KB" src="/images/template/icons/doc-pdf.png" alt="PDF format" /></a> </td>
</tr>
<tr>
  <td class="date">21 July 2026</td>
  <td>Chester, Mr Darren, Member for Gippsland </td>
  <td class="format"> <a href="/-/media/03_Senators_and_Members/32_Members/Register/48p/CF/ChesterD_48P.pdf"><img title="553KB" src="/images/template/icons/doc-pdf.png" alt="PDF format" /></a> </td>
</tr>
<tr>
  <td class="date">8 August 2025</td>
  <td>Scrymgour, Ms Marion, Member for Lingiari, NT </td>
  <td class="format"> <a href="/-/media/03_Senators_and_Members/32_Members/Register/48p/SZ/Scrymgour.pdf"><img title="246KB" src="/images/template/icons/doc-pdf.png" alt="PDF format" /></a> </td>
</tr>
<tr>
  <td class="date">30 July 2025</td>
  <td>O'Brien, Mr Llew, Member for Wide Bay, QLD </td>
  <td class="format"> <a href="/-/media/03_Senators_and_Members/32_Members/Register/48p/KN/Llewellyn_OBrien48P.pdf"><img title="243KB" src="/images/template/icons/doc-pdf.png" alt="PDF format" /></a> </td>
</tr>
<tr>
  <td>Explanatory notes</td>
  <td class="format"> <a href="/-/media/03_Senators_and_Members/32_Members/Register/Explanatory_notes/Explanatory_Notes___Booklet_1.pdf">notes</a> </td>
</tr>
</tbody></table></body></html>`

func parseFixture(t *testing.T, html string) *goquery.Document {
	t.Helper()
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(html))
	if err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	return doc
}

func TestParseHouseListing(t *testing.T) {
	const pageURL = aphBase + houseRegisterPath
	docs, err := parseHouseListing(parseFixture(t, houseListingFixture), pageURL, 48)
	if err != nil {
		t.Fatalf("parseHouseListing: %v", err)
	}

	// The explanatory-notes booklet lives under .../Register/Explanatory_notes/,
	// which shares the media prefix with real member statements. A prefix-only
	// filter ingests it as if it were a member — so the count assertion here is
	// load-bearing, not decoration.
	if len(docs) != 4 {
		var got string
		for _, d := range docs {
			got += "\n  " + d.SourceURL
		}
		t.Fatalf("discovered %d documents, want 4 member rows (non-member PDFs must be excluded):%s", len(docs), got)
	}

	byURL := map[string]RegisterDocument{}
	for _, d := range docs {
		byURL[d.SourceURL] = d
	}

	albo, ok := byURL[aphBase+"/-/media/03_Senators_and_Members/32_Members/Register/48p/AB/Albanese_48P.pdf"]
	if !ok {
		t.Fatalf("Albanese row not discovered; got %d docs", len(docs))
	}
	if albo.Chamber != "house" || albo.Parliament != 48 {
		t.Errorf("chamber/parliament = %q/%d, want house/48", albo.Chamber, albo.Parliament)
	}
	if albo.MemberHint != "Albanese, Hon Anthony, Member for Grayndler, NSW" {
		t.Errorf("MemberHint = %q", albo.MemberHint)
	}
	if albo.DivisionHint != "Grayndler" || albo.StateHint != "NSW" {
		t.Errorf("division/state = %q/%q, want Grayndler/NSW", albo.DivisionHint, albo.StateHint)
	}
	if albo.ListedSizeLabel != "4948KB" {
		t.Errorf("ListedSizeLabel = %q, want 4948KB", albo.ListedSizeLabel)
	}
	if albo.LastUpdatedAt == nil || !albo.LastUpdatedAt.Equal(time.Date(2026, time.July, 9, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("LastUpdatedAt = %v, want 2026-07-09", albo.LastUpdatedAt)
	}
	if albo.ListingURL != pageURL {
		t.Errorf("ListingURL = %q", albo.ListingURL)
	}

	// A member with no state token must still yield the division.
	chester := byURL[aphBase+"/-/media/03_Senators_and_Members/32_Members/Register/48p/CF/ChesterD_48P.pdf"]
	if chester.DivisionHint != "Gippsland" {
		t.Errorf("Chester division = %q, want Gippsland", chester.DivisionHint)
	}
	if chester.StateHint != "" {
		t.Errorf("Chester state = %q, want empty (the listing omits it)", chester.StateHint)
	}

	// Identity must survive an irregular filename and an apostrophe surname.
	obrien := byURL[aphBase+"/-/media/03_Senators_and_Members/32_Members/Register/48p/KN/Llewellyn_OBrien48P.pdf"]
	if !strings.HasPrefix(obrien.MemberHint, "O'Brien,") {
		t.Errorf("O'Brien MemberHint = %q", obrien.MemberHint)
	}
	if obrien.DivisionHint != "Wide Bay" || obrien.StateHint != "QLD" {
		t.Errorf("O'Brien division/state = %q/%q", obrien.DivisionHint, obrien.StateHint)
	}
}

func TestParseHouseListingIsIdempotentOnDuplicateHrefs(t *testing.T) {
	dup := strings.Replace(houseListingFixture, "</tbody>", `
<tr>
  <td class="date">9 July 2026</td>
  <td>Albanese, Hon Anthony, Member for Grayndler, NSW </td>
  <td class="format"> <a href="/-/media/03_Senators_and_Members/32_Members/Register/48p/AB/Albanese_48P.pdf"><img title="4948KB" /></a> </td>
</tr></tbody>`, 1)
	docs, err := parseHouseListing(parseFixture(t, dup), aphBase+houseRegisterPath, 48)
	if err != nil {
		t.Fatalf("parseHouseListing: %v", err)
	}
	seen := map[string]int{}
	for _, d := range docs {
		seen[d.SourceURL]++
	}
	for u, n := range seen {
		if n != 1 {
			t.Errorf("%s discovered %d times, want 1", u, n)
		}
	}
}

func TestParseHouseNameCell(t *testing.T) {
	// Every one of these is a real listing cell. The lower five are the source's
	// own wording drift, found by checking the 5 rows that failed to yield a
	// division on a full 769-document discovery run — not hypotheticals.
	cases := []struct {
		cell, division, state string
	}{
		{"Albanese, Hon Anthony, Member for Grayndler, NSW", "Grayndler", "NSW"},
		{"Chester, Mr Darren, Member for Gippsland", "Gippsland", ""},
		{"O'Brien, Mr Llew, Member for Wide Bay, QLD", "Wide Bay", "QLD"},
		{"Scrymgour, Ms Marion, Member for Lingiari, NT", "Lingiari", "NT"},
		{"Le, Ms Dai, Member for Fowler, NSW", "Fowler", "NSW"},

		// 44P: members who left mid-parliament are listed as "Former Member for".
		{"Hockey, The Hon Joe, Former Member for North Sydney, NSW", "North Sydney", "NSW"},
		{"Randall, Mr Don, Former Member for Canning, WA", "Canning", "WA"},
		// 44P: "Member" simply missing.
		{"Hastie, Mr Andrew, for Canning, WA", "Canning", "WA"},
		// 46P: no "for", and the state is inside the same comma-part.
		{"McBain, Ms Kristy , Member Eden-Monaro NSW", "Eden-Monaro", "NSW"},

		// An honorific must never be mistaken for a seat.
		{"Husic, The Hon Edham, Member for Chifley, NSW", "Chifley", "NSW"},

		// Footnote markers glued to the state token (45P/46P/47P).
		{"Kelly, Hon Dr Mike, Member for Eden-Monaro, NSW¹", "Eden-Monaro", "NSW"},
		{"Keay, Ms Justine, Member for Braddon, TAS³", "Braddon", "TAS"},
		{"Sharkie, Ms Rebekha, Member for Mayo, SA⁴", "Mayo", "SA"},
		{"Georganas, Mr Steven, Member for Adelaide, SAC", "Adelaide", "SA"},
		{"Aly, Professor Anne, Member for Cowan, WAW", "Cowan", "WA"},
		// A trailing comma leaves an empty state part.
		{"Butler, Ms Terri, Member for Griffith,", "Griffith", ""},
		// Trailing punctuation on the division drifts between parliaments
		// ("Flynn" in 48P vs "Flynn." in 47P). Division is the join key to
		// suburb_demographics.federal_division, so a stray period costs a member
		// all of their represented suburbs.
		{"Boyce, Mr Colin, Member for Flynn., QLD", "Flynn", "QLD"},
		{"", "", ""},
	}
	for _, tc := range cases {
		gotDiv, gotState := parseHouseNameCell(tc.cell)
		if gotDiv != tc.division || gotState != tc.state {
			t.Errorf("parseHouseNameCell(%q) = %q/%q, want %q/%q", tc.cell, gotDiv, gotState, tc.division, tc.state)
		}
	}
}

// senateListingFixture reproduces the real <li><a><strong>…</strong></a></li>
// shape, including the three relative href forms and the messy labels.
const senateListingFixture = `<html><body><ul class="no-bullet">
<li><a class="document-download fa-icon pdf" href="-/media/FB79802AD0754CB3AC0564B082B5C10A.ashx"><strong>lodged between 20 August 2025 and 31 December 2025</strong> (PDF 5MB)</a></li>
<li><a class="document-download fa-icon pdf" href="-/media/5506647FCC8749E2834D986706181604.ashx"><strong>lodged between 1 July 2025 and 19 August 2025 - Volume 1</strong> (PDF 2MB)</a></li>
<li><a class="document-download fa-icon pdf" href="/-/media/6A906F536AC74B55B849718F5E34763D.ashx"><strong>lodged between 1 July 2022 and 31 August 2022 - Volume 1</strong> (PDF 2MB)</a></li>
<li><a class="document-download fa-icon pdf" href="~/media/CFAF5616B8B2430DB07BF60B08E30DA6.ashx"><strong>lodged between 1 July and 31 August 2014 - Volume 1</strong> (PDF 17.957Kb)</a></li>
<li><a class="document-download fa-icon pdf" href="~/media/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.ashx"><strong>lodged between 27 June and 10 December 2013</strong> (PDF 10.7Mb)</a></li>
<li><a class="document-download fa-icon pdf" href="~/media/5D8BFE467ACC44BCB0DB885BF959E98C.ashx"><strong>lodged by 5 August 2011 (statements only) - Volume 1</strong> (PDF 7.9Mb)</a></li>
<li><a class="document-download fa-icon pdf" href="~/media/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB.ashx"><strong>lodged between 21 June 2005 and 12 September 2005 - Volume 1</strong> (PDF 188Mb)</a></li>
<li><a href="/Parliamentary_Business/Committees/Senate/Senators_Interests/Reports">Reports</a></li>
</ul></body></html>`

func TestParseSenateListingKeepsOnlyInWindowVolumes(t *testing.T) {
	const pageURL = aphBase + senateVolumesPath
	docs, err := parseSenateListing(parseFixture(t, senateListingFixture), pageURL)
	if err != nil {
		t.Fatalf("parseSenateListing: %v", err)
	}

	// 2011 and 2005 volumes end before the 44th-Parliament cutoff and must be
	// dropped; the non-volume "Reports" link must never be picked up.
	if len(docs) != 5 {
		for _, d := range docs {
			t.Logf("  kept: %s | %s", d.VolumeLabel, d.SourceURL)
		}
		t.Fatalf("kept %d volumes, want 5 (2011 + 2005 out of window, Reports not a volume)", len(docs))
	}

	for _, d := range docs {
		if d.Chamber != "senate" {
			t.Errorf("chamber = %q", d.Chamber)
		}
		if d.Parliament != 0 {
			t.Errorf("senate volumes must not claim a parliament, got %d", d.Parliament)
		}
		if !strings.HasPrefix(d.SourceURL, aphBase+"/-/media/") || !strings.HasSuffix(d.SourceURL, ".ashx") {
			t.Errorf("unnormalised senate URL: %s", d.SourceURL)
		}
	}
}

func TestNormaliseSenateMediaURL(t *testing.T) {
	const guid = "5506647FCC8749E2834D986706181604"
	want := aphBase + "/-/media/" + guid + ".ashx"
	// All three relative forms on the page resolve to the same absolute URL.
	// Resolving the bare "-/media/…" form against the page URL with base.Parse
	// would wrongly yield ".../Senators_Interests/-/media/…", which is why this
	// is normalised explicitly.
	for _, href := range []string{
		"-/media/" + guid + ".ashx",
		"/-/media/" + guid + ".ashx",
		"~/media/" + guid + ".ashx",
		"/~/media/" + strings.ToLower(guid) + ".ashx",
	} {
		got, ok := normaliseSenateMediaURL(href)
		if !ok {
			t.Errorf("normaliseSenateMediaURL(%q) not matched", href)
			continue
		}
		if got != want {
			t.Errorf("normaliseSenateMediaURL(%q) = %q, want %q", href, got, want)
		}
	}
	if _, ok := normaliseSenateMediaURL("/Parliamentary_Business/Committees/Senate"); ok {
		t.Error("a non-media href must not be treated as a volume")
	}
}

func TestParseSenateVolumeLabel(t *testing.T) {
	d := func(y int, m time.Month, day int) *time.Time {
		t := time.Date(y, m, day, 0, 0, 0, 0, time.UTC)
		return &t
	}
	eq := func(a, b *time.Time) bool {
		if a == nil || b == nil {
			return a == b
		}
		return a.Equal(*b)
	}
	boolp := func(b bool) *bool { return &b }

	cases := []struct {
		label      string
		from, to   *time.Time
		volume     int
		stmtsOnly  *bool
		nameOfCase string
	}{
		{
			label: "lodged between 1 July 2025 and 19 August 2025 - Volume 1 (PDF 2MB)",
			from:  d(2025, time.July, 1), to: d(2025, time.August, 19), volume: 1,
			nameOfCase: "standard split volume",
		},
		{
			label: "lodged between 20 August 2025 and 31 December 2025 (PDF 5MB)",
			from:  d(2025, time.August, 20), to: d(2025, time.December, 31), volume: 0,
			nameOfCase: "unsplit window",
		},
		{
			// The first date carries no year and must borrow 2014.
			label: "lodged between 1 July and 31 August 2014 - Volume 1 (PDF 17.957Kb)",
			from:  d(2014, time.July, 1), to: d(2014, time.August, 31), volume: 1,
			nameOfCase: "year-less first date",
		},
		{
			// "to" rather than "and".
			label: "lodged between 1 January 2021 to 30 June 2021 (PDF 1.7Mb)",
			from:  d(2021, time.January, 1), to: d(2021, time.June, 30), volume: 0,
			nameOfCase: "to instead of and",
		},
		{
			// Open start + a statements-only marker.
			label: "lodged by 5 August 2011 (statements only) - Volume 1 (PDF 7.9Mb)",
			from:  nil, to: d(2011, time.August, 5), volume: 1, stmtsOnly: boolp(true),
			nameOfCase: "lodged by, statements only",
		},
		{
			label: "lodged between 1 July and 5 August 2011 (alterations only) (PDF 2.3Mb)",
			from:  d(2011, time.July, 1), to: d(2011, time.August, 5), volume: 0, stmtsOnly: boolp(false),
			nameOfCase: "alterations only",
		},
		{
			// Source typo "NoveMber" must still parse.
			label: "lodged between 20 June 2003 and 27 NoveMber 2003 (PDF 37Mb)",
			from:  d(2003, time.June, 20), to: d(2003, time.November, 27), volume: 0,
			nameOfCase: "source typo in month",
		},
		{
			// Older "Volume - 1" form.
			label: "lodged by 2 June 1994 Volume - 1 (PDF 24Mb)",
			from:  nil, to: d(1994, time.June, 2), volume: 1,
			nameOfCase: "legacy volume form",
		},
	}

	for _, tc := range cases {
		from, to, volume, stmtsOnly := parseSenateVolumeLabel(tc.label)
		if !eq(from, tc.from) {
			t.Errorf("%s: from = %v, want %v", tc.nameOfCase, from, tc.from)
		}
		if !eq(to, tc.to) {
			t.Errorf("%s: to = %v, want %v", tc.nameOfCase, to, tc.to)
		}
		if volume != tc.volume {
			t.Errorf("%s: volume = %d, want %d", tc.nameOfCase, volume, tc.volume)
		}
		switch {
		case tc.stmtsOnly == nil && stmtsOnly != nil:
			t.Errorf("%s: statementsOnly = %v, want nil", tc.nameOfCase, *stmtsOnly)
		case tc.stmtsOnly != nil && stmtsOnly == nil:
			t.Errorf("%s: statementsOnly = nil, want %v", tc.nameOfCase, *tc.stmtsOnly)
		case tc.stmtsOnly != nil && *stmtsOnly != *tc.stmtsOnly:
			t.Errorf("%s: statementsOnly = %v, want %v", tc.nameOfCase, *stmtsOnly, *tc.stmtsOnly)
		}
	}
}

func TestParseAPHDate(t *testing.T) {
	cases := []struct {
		in   string
		want time.Time
	}{
		{" 9  July 2026 ", time.Date(2026, time.July, 9, 0, 0, 0, 0, time.UTC)},
		{"09 July 2026", time.Date(2026, time.July, 9, 0, 0, 0, 0, time.UTC)},
		// Real 46P cell: the source lost the space between day and month.
		{"1April 2020", time.Date(2020, time.April, 1, 0, 0, 0, 0, time.UTC)},
	}
	for _, tc := range cases {
		got, ok := parseAPHDate(tc.in)
		if !ok || !got.Equal(tc.want) {
			t.Errorf("parseAPHDate(%q) = %v, %v; want %v", tc.in, got, ok, tc.want)
		}
	}
	if _, ok := parseAPHDate("not a date"); ok {
		t.Error("parseAPHDate accepted junk")
	}
}

// The whole crawl depends on sending NO User-Agent: APH's WAF allowlists
// real-browser tokens and 403s everything else, including Go's default. This
// asserts we never regress into sending one (which would be a silent 403 storm)
// and never start spoofing a browser (which would be WAF evasion).
func TestNewAPHRequestSendsNoUserAgentButSelfIdentifies(t *testing.T) {
	req, err := newAPHRequest(t.Context(), aphBase+houseRegisterPath)
	if err != nil {
		t.Fatalf("newAPHRequest: %v", err)
	}

	values, present := req.Header["User-Agent"]
	if !present {
		t.Fatal("User-Agent key absent: net/http would substitute its default, which APH 403s")
	}
	if len(values) != 0 {
		t.Errorf("User-Agent = %q, want no value at all", values)
	}
	if got := req.Header.Get("From"); got != registerContactEmail {
		t.Errorf("From = %q, want %q", got, registerContactEmail)
	}
	if got := req.Header.Get("X-Crawler-Contact"); got != registerContactURL {
		t.Errorf("X-Crawler-Contact = %q, want %q", got, registerContactURL)
	}

	// Prove it over the wire, not just on the struct.
	var seen http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		seen = r.Header.Clone()
	}))
	defer srv.Close()

	wireReq, err := newAPHRequest(t.Context(), srv.URL)
	if err != nil {
		t.Fatalf("newAPHRequest: %v", err)
	}
	resp, err := srv.Client().Do(wireReq)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	_ = resp.Body.Close()

	if ua := seen.Get("User-Agent"); ua != "" {
		t.Errorf("server saw User-Agent %q; APH would 403 this", ua)
	}
	if seen.Get("From") != registerContactEmail {
		t.Errorf("server saw From %q", seen.Get("From"))
	}
}

func TestHouseParliamentCoverage(t *testing.T) {
	if len(houseParliaments) != len(housePreviousParliamentPaths) {
		t.Fatalf("houseParliaments (%d) and housePreviousParliamentPaths (%d) disagree",
			len(houseParliaments), len(housePreviousParliamentPaths))
	}
	for _, p := range houseParliaments {
		if _, ok := housePreviousParliamentPaths[p]; !ok {
			t.Errorf("parliament %d has no listing path", p)
		}
	}
	// Newest first, so a -register-limit run always covers the current parliament.
	for i := 1; i < len(houseParliaments); i++ {
		if houseParliaments[i-1] <= houseParliaments[i] {
			t.Errorf("houseParliaments must be descending, got %v", houseParliaments)
			break
		}
	}
}

func TestNormaliseStateToken(t *testing.T) {
	ok := map[string]string{
		"NSW": "NSW", "vic": "VIC", "QLD": "QLD", "SA": "SA", "WA": "WA",
		"TAS": "TAS", "NT": "NT", "ACT": "ACT",
		// Footnote markers, superscript and letter forms.
		"NSW¹": "NSW", "QLD²": "QLD", "TAS³": "TAS", "SA⁴": "SA",
		"SAC": "SA", "WAW": "WA", "WA3": "WA", "NSW.": "NSW",
	}
	for in, want := range ok {
		got, matched := normaliseStateToken(in)
		if !matched || got != want {
			t.Errorf("normaliseStateToken(%q) = %q, %v; want %q", in, got, matched, want)
		}
	}
	// A real three-letter state must never be truncated into a two-letter one,
	// and non-states must not be coerced.
	for _, in := range []string{"", "Member for Cowan", "Grayndler", "XYZ", "N"} {
		if got, matched := normaliseStateToken(in); matched {
			t.Errorf("normaliseStateToken(%q) = %q, want no match", in, got)
		}
	}
}
