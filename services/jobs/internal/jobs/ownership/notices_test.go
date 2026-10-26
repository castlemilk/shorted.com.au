package ownership

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/ledongthuc/pdf"
)

var passCompanies = map[string]company{
	"CAR": {Code: "CAR", Name: "CAR Group Limited"},
	"CBA": {Code: "CBA", Name: "Commonwealth Bank of Australia"},
	"WTC": {Code: "WTC", Name: "WiseTech Global Limited"},
	"MQG": {Code: "MQG", Name: "Macquarie Group Limited"},
	"MIN": {Code: "MIN", Name: "Mineral Resources Limited"},
	"WC8": {Code: "WC8", Name: "Wildcat Resources Limited"},
	"ZIP": {Code: "ZIP", Name: "Zip Co Limited"},
}

func TestResolveTarget(t *testing.T) {
	tests := []struct {
		name     string
		p        pendingNotice
		docCo    string
		want     string
		wantMiss bool
	}{
		// A listed holder's notice: titled "for <target>" under both codes.
		{"for CAR", pendingNotice{Headline: "Becoming a substantial holder for CAR", ListedCodes: []string{"CBA", "CAR"}}, "", "CAR", false},
		// "from <holder>" under the target and the holder.
		{"from MQG", pendingNotice{Headline: "Ceasing to be a substantial holder from MQG", ListedCodes: []string{"WTC", "MQG"}}, "", "WTC", false},
		{"one code", pendingNotice{Headline: "Change in substantial holding", ListedCodes: []string{"ZIP"}}, "", "ZIP", false},
		// No for/from: the notice's own "To" line decides.
		{"to line", pendingNotice{Headline: "Change in substantial holding", ListedCodes: []string{"MIN", "WC8"}}, "Wildcat Resources Limited ( WC8 )", "WC8", false},
		{"ambiguous", pendingNotice{Headline: "Change in substantial holding", ListedCodes: []string{"MIN", "WC8"}}, "", "", true},
		{"in CAR", pendingNotice{Headline: "Becoming a substantial holder in CAR", ListedCodes: []string{"CBA"}}, "", "CAR", false},
		// The target has since delisted: listed only under the holder's code,
		// which must not take the notice.
		{"for a delisted target", pendingNotice{Headline: "Change in substantial holding for IRE", ListedCodes: []string{"CBA"}}, "", "", true},
	}
	for _, tc := range tests {
		got, why := resolveTarget(tc.p, tc.docCo, passCompanies)
		if got != tc.want || (why != "") != tc.wantMiss {
			t.Errorf("%s: resolveTarget = %q (%s), want %q", tc.name, got, why, tc.want)
		}
	}
}

func TestResolveHolder(t *testing.T) {
	byKey := companiesByHolderKey(passCompanies)
	tests := []struct {
		name, holder, wantKey, wantSlug string
	}{
		{"curated", "JPMorgan Chase & Co. and its affiliates", "jpmorgan", "jpmorgan"},
		{"earliest alias wins", "Mitsubishi UFJ Financial Group, Inc. (on behalf of Morgan Stanley)", "mufg", "mufg"},
		// A listed company holding another: a corporate holder.
		{"listed company", "Mineral Resources Limited (MinRes) and its related bodies corporate", "asx:MIN", ""},
		{"by name", "Wesley Jon Maas and Emma Margaret Maas", "name:wesley jon maas and emma margaret maas", ""},
		{"legal suffixes group", "Acme Capital Pty Ltd", "name:acme capital", ""},
	}
	for _, tc := range tests {
		h, ok := resolveHolder(Notice{HolderName: tc.holder}, "", byKey)
		if !ok || h.Key != tc.wantKey || h.InstitutionSlug != tc.wantSlug {
			t.Errorf("%s: resolveHolder(%q) = %+v %v, want key %q slug %q", tc.name, tc.holder, h, ok, tc.wantKey, tc.wantSlug)
		}
	}
	if _, ok := resolveHolder(Notice{}, "no names here at all", byKey); ok {
		t.Error("a notice with no holder resolved to one")
	}
}

func TestTidyHolderNameAndKey(t *testing.T) {
	for in, want := range map[string]string{
		"JPMorgan Chase & Co. and its affiliates":                             "JPMorgan Chase & Co",
		"State Street Corporation and subsidiaries named in paragraph 6":      "State Street Corporation",
		"Macquarie Group Limited ('MQG'); and its controlled bodies":          "Macquarie Group Limited",
		"UBS Group AG and its related bodies corporate":                       "UBS Group AG",
		"FMR LLC and its entities listed in Annexure A":                       "FMR LLC",
		"Australian Retirement Trust Pty LTD ATF Australian Retirement Trust": "Australian Retirement Trust Pty LTD ATF Australian Retirement Trust",
	} {
		if got := tidyHolderName(in); got != want {
			t.Errorf("tidyHolderName(%q) = %q, want %q", in, got, want)
		}
	}
	if holderKey("Acme Capital Pty Limited") != holderKey("ACME CAPITAL PTY LTD") {
		t.Error("legal suffixes split one holder in two")
	}
}

func TestVotesConsistent(t *testing.T) {
	// 62,856,312 votes at 5.045% implies 1.246bn shares.
	if ok, _ := votesConsistent(new(int64(62856312)), new(5.045), 1.246e9); !ok {
		t.Error("a consistent notice was refused")
	}
	// A mis-split cell: 79 votes at 6.72%.
	if ok, why := votesConsistent(new(int64(79000)), new(6.72), 650e6); ok {
		t.Error("an inconsistent notice was accepted")
	} else if !strings.Contains(why, "on issue") {
		t.Errorf("detail %q", why)
	}
	// Nothing to check against: accepted.
	if ok, _ := votesConsistent(new(int64(1)), new(float64(6)), 0); !ok {
		t.Error("an unknown share count refused a notice")
	}
}

func TestPlausibleEventDate(t *testing.T) {
	for _, tc := range []struct{ event, announced, want string }{
		{"2026-10-13", "2026-10-16", "2026-10-13"},
		{"2020-02-20", "2026-03-01", ""}, // a typo'd year
		{"2026-10-18", "2026-10-16", ""}, // after the release
		{"", "2026-10-16", ""},
	} {
		if got := plausibleEventDate(tc.event, tc.announced); got != tc.want {
			t.Errorf("plausibleEventDate(%q, %q) = %q, want %q", tc.event, tc.announced, got, tc.want)
		}
	}
}

func TestRegistryIsValid(t *testing.T) {
	if err := validateRegistry(registry); err != nil {
		t.Fatal(err)
	}
	dup := append([]Institution{}, registry...)
	dup = append(dup, Institution{Slug: "copy", Name: "Copy", Kind: KindOther, Aliases: []string{"vanguard group"}})
	if err := validateRegistry(dup); err == nil {
		t.Error("a shared alias passed validation")
	}
	for _, bad := range []Institution{
		{Slug: "orphan", Name: "Orphan", Kind: KindOther, Aliases: []string{"orphan fund"}, Group: "no-such-institution"},
		// first-sentier is itself in mufg's group: groups are one level deep.
		{Slug: "nested", Name: "Nested", Kind: KindOther, Aliases: []string{"nested fund"}, Group: "first-sentier"},
	} {
		if err := validateRegistry(append(append([]Institution{}, registry...), bad)); err == nil {
			t.Errorf("group %q passed validation", bad.Group)
		}
	}
}

// fakeStore is the pass's database in memory.
type fakeStore struct {
	mu       sync.Mutex
	pending  []pendingNotice
	rows     []noticeRow
	attempts map[string]noticeAttempt
	failRows bool
}

func (f *fakeStore) PendingNotices(context.Context, int, string, int) ([]pendingNotice, error) {
	return f.pending, nil
}
func (f *fakeStore) Companies(context.Context) (map[string]company, error) { return passCompanies, nil }
func (f *fakeStore) SharesOnIssue(_ context.Context, code, _ string) (float64, error) {
	if code == "ZIP" {
		return 1.246e9, nil
	}
	return 0, nil
}
func (f *fakeStore) UpsertNotice(_ context.Context, r noticeRow) error {
	if f.failRows {
		return errors.New("db down")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rows = append(f.rows, r)
	return nil
}
func (f *fakeStore) RecordAttempt(_ context.Context, a noticeAttempt, _ int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.attempts[a.URL] = a
	return nil
}

// fakePDFs serves fixture text as if it were each URL's PDF.
type fakePDFs map[string]string

func (f fakePDFs) PDF(_ context.Context, url string) ([]byte, error) {
	if s, ok := f[url]; ok {
		return []byte(s), nil
	}
	return nil, errors.New("HTTP 404")
}

type passthrough struct{}

func (passthrough) extract(_ context.Context, b []byte) (string, error) { return string(b), nil }

func TestNoticePass(t *testing.T) {
	read := func(name string) string {
		b, err := os.ReadFile(filepath.Join("testdata", "notices", name+".txt"))
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	store := &fakeStore{attempts: map[string]noticeAttempt{}, pending: []pendingNotice{
		{URL: "zip", Headline: "Becoming a substantial holder", AnnouncedOn: "2026-10-16", ListedCodes: []string{"ZIP"}},
		{URL: "car", Headline: "Becoming a substantial holder for CAR", AnnouncedOn: "2026-09-25", ListedCodes: []string{"CBA", "CAR"}},
		{URL: "scan", Headline: "Change in substantial holding", AnnouncedOn: "2026-06-24", ListedCodes: []string{"ZIP"}},
		{URL: "missing", Headline: "Change in substantial holding", AnnouncedOn: "2026-06-24", ListedCodes: []string{"ZIP"}},
	}}
	pdfs := fakePDFs{
		"zip":  read("zip_603_art_spaced_commas"),
		"car":  read("car_603_commonwealth_bank_grand_total"),
		"scan": read("ltr_scan_no_text"),
	}
	pass := &noticePass{store: store, pdfs: pdfs, extractor: passthrough{}, workers: 2, logf: t.Logf}
	res, err := pass.run(context.Background(), 10, "2025-01-01")
	if err != nil {
		t.Fatal(err)
	}
	if res.Parsed != 2 || res.Outcomes["no_text"] != 1 || res.Outcomes["fetch_error"] != 1 {
		t.Fatalf("outcomes %+v", res.Outcomes)
	}
	byURL := map[string]noticeRow{}
	for _, r := range store.rows {
		byURL[r.URL] = r
	}
	if r := byURL["car"]; r.StockCode != "CAR" || r.HolderKey != "commonwealth-bank" || *r.PresentPct != 5.01 || r.EventDate != "2026-09-23" {
		t.Errorf("CAR row %+v", r)
	}
	if r := byURL["zip"]; r.StockCode != "ZIP" || r.InstitutionSlug != "australian-retirement-trust" {
		t.Errorf("ZIP row %+v", r)
	}
	if a := store.attempts["car"]; a.Outcome != "parsed" || a.StockCode != "CAR" {
		t.Errorf("CAR attempt %+v", a)
	}

	// A failed write records no attempt, so the notice is read again.
	failing := &fakeStore{attempts: map[string]noticeAttempt{}, failRows: true, pending: store.pending[:1]}
	pass.store = failing
	if _, err := pass.run(context.Background(), 10, "2025-01-01"); err != nil {
		t.Fatal(err)
	}
	if _, ok := failing.attempts["zip"]; ok {
		t.Error("a notice whose row failed to write recorded an attempt")
	}

	// A dry run writes nothing.
	dry := &fakeStore{attempts: map[string]noticeAttempt{}, pending: store.pending}
	pass.store, pass.dryRun = dry, true
	if _, err := pass.run(context.Background(), 10, "2025-01-01"); err != nil {
		t.Fatal(err)
	}
	if len(dry.rows) != 0 || len(dry.attempts) != 0 {
		t.Errorf("a dry run wrote %d rows and %d attempts", len(dry.rows), len(dry.attempts))
	}
}

func TestLayoutTexts(t *testing.T) {
	g := func(s string, x, y float64) pdf.Text { return pdf.Text{S: s, X: x, Y: y, W: 5, FontSize: 9} }
	texts := []pdf.Text{
		// Drawn in this order: the label, then (a form field drawn last) its value.
		g("N", 50, 700), g("a", 55, 700), g("m", 60, 700), g("e", 65, 700),
		g("O", 50, 680), g("t", 55, 680), g("h", 60, 680),
		// A zero-width newline item between glyphs is dropped.
		g("5", 200, 700), {S: "\n", X: 205, Y: 700, FontSize: 9}, g("5", 205, 700), g("%", 210, 700),
	}
	got := layoutTexts(texts)
	want := "Name | 55%\nOth\n"
	if got != want {
		t.Errorf("layoutTexts = %q, want %q", got, want)
	}
}

func TestRelinkHolder(t *testing.T) {
	tests := []struct {
		name, key, slug          string
		wantName, wantKey, slug2 string
		changed                  bool
	}{
		// A bare institution name resolves exactly.
		{"UBS", "name:ubs", "", "UBS", "ubs", "ubs", true},
		// Linked from the notice's text: the name resolves to nothing, the link stays.
		{"Unreadable holder", "blackrock", "blackrock", "Unreadable holder", "blackrock", "blackrock", false},
		// The institution left the map: back to the name.
		{"Gone Capital Pty Ltd", "gone-capital", "gone-capital", "Gone Capital Pty Ltd", "name:gone capital", "", true},
		// A new boilerplate tail: the name and its key are re-tidied.
		{"M&G Plc and its subsidiary companies", "name:m and g plc and its subsidiary companies", "", "M&G Plc", "name:m and g", "", true},
		{"DGT and each of DGT's subsidiaries listed in Annexure A", "name:dgt and each of dgts subsidiaries listed in annexure a", "", "DGT", "name:dgt", "", true},
		// A listed company keeps its code.
		{"Sandfire Resources Limited", "asx:SFR", "", "Sandfire Resources Limited", "asx:SFR", "", false},
	}
	for _, tc := range tests {
		n, k, s, changed := relinkHolder(tc.name, tc.key, tc.slug)
		if n != tc.wantName || k != tc.wantKey || s != tc.slug2 || changed != tc.changed {
			t.Errorf("relinkHolder(%q, %q, %q) = %q, %q, %q, %v; want %q, %q, %q, %v",
				tc.name, tc.key, tc.slug, n, k, s, changed, tc.wantName, tc.wantKey, tc.slug2, tc.changed)
		}
	}
}
