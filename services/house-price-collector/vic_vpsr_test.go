package main

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/PuerkitoBio/goquery"
	"github.com/xuri/excelize/v2"
)

type fakeVICWorkbookResponse struct {
	body []byte
	err  error
}

type fakeVICFetcher struct {
	listingDoc *goquery.Document
	listingURL *url.URL
	listingErr error
	workbooks  map[string]fakeVICWorkbookResponse
	byteCalls  []string
}

func (f *fakeVICFetcher) FetchHTML(context.Context, string) (*goquery.Document, *url.URL, error) {
	return f.listingDoc, f.listingURL, f.listingErr
}

func (f *fakeVICFetcher) FetchBytes(_ context.Context, pageURL, _ string) ([]byte, string, error) {
	f.byteCalls = append(f.byteCalls, pageURL)
	resp, ok := f.workbooks[pageURL]
	if !ok {
		return nil, "", errors.New("unexpected workbook URL")
	}
	return resp.body, xlsxAccept, resp.err
}

func vicListingDocument(t *testing.T, html string) *goquery.Document {
	t.Helper()
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(html))
	if err != nil {
		t.Fatal(err)
	}
	return doc
}

func mustURL(t *testing.T, rawURL string) *url.URL {
	t.Helper()
	u, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func vicZIPFixture(t *testing.T, name string, contents []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(contents); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func vicNamedGarbageXLSXFixture(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, name := range []string{"[Content_Types].xml", "xl/workbook.xml"} {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte("not valid xlsx xml")); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestSelectVICWorkbookURLChoosesLatestCandidate(t *testing.T) {
	base := mustURL(t, "https://www.land.vic.gov.au/valuations/property-sales-statistics")
	doc := vicListingDocument(t, `<main>
		<a href="/__data/houses-by-suburb-2014-2024.xlsx">old</a>
		<a href="/__data/houses-by-suburb-2015-2025.xlsx">latest lower start</a>
		<a href="/__data/HOUSES-BY-SUBURB-2016-2025.XLSX">latest higher start</a>
	</main>`)

	got, err := selectVICWorkbookURL(doc, base)
	if err != nil {
		t.Fatal(err)
	}
	want := "https://www.land.vic.gov.au/__data/HOUSES-BY-SUBURB-2016-2025.XLSX"
	if got != want {
		t.Fatalf("selected URL = %q, want %q", got, want)
	}
}

func TestSelectVICWorkbookURLResolvesAgainstFinalPageURL(t *testing.T) {
	base := mustURL(t, "https://www.land.vic.gov.au/valuations/resources-and-reports/")
	doc := vicListingDocument(t, `<a href="../assets/houses-by-suburb-2015-2025.xlsx">workbook</a>`)

	got, err := selectVICWorkbookURL(doc, base)
	if err != nil {
		t.Fatal(err)
	}
	want := "https://www.land.vic.gov.au/valuations/assets/houses-by-suburb-2015-2025.xlsx"
	if got != want {
		t.Fatalf("selected URL = %q, want %q", got, want)
	}
}

func TestSelectVICWorkbookURLRejectsExternalHostAndNoMatch(t *testing.T) {
	base := mustURL(t, "https://www.land.vic.gov.au/valuations/property-sales-statistics")
	for _, tc := range []struct {
		name string
		html string
	}{
		{name: "external host", html: `<a href="https://example.com/houses-by-suburb-2015-2025.xlsx">workbook</a>`},
		{name: "no matching filename", html: `<a href="/__data/units-by-suburb-2015-2025.xlsx">workbook</a>`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := selectVICWorkbookURL(vicListingDocument(t, tc.html), base)
			if err == nil {
				t.Fatal("expected no-candidate error")
			}
		})
	}
}

func TestFetchVICSuburbWorkbookFallsBackWhenDiscoveryFails(t *testing.T) {
	want := vicFixture(t)
	fetcher := &fakeVICFetcher{
		listingErr: errors.New("listing unavailable"),
		workbooks: map[string]fakeVICWorkbookResponse{
			vicXLSXURL: {body: want},
		},
	}

	got, err := fetchVICSuburbWorkbook(context.Background(), fetcher)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("workbook = %q, want %q", got, want)
	}
	if len(fetcher.byteCalls) != 1 || fetcher.byteCalls[0] != vicXLSXURL {
		t.Fatalf("workbook calls = %v, want fallback once", fetcher.byteCalls)
	}
}

func TestFetchVICSuburbWorkbookFallsBackWithoutFetchingOlderDiscoveredWorkbook(t *testing.T) {
	older := "https://www.land.vic.gov.au/__data/houses-by-suburb-2013-2023.xlsx"
	want := vicFixture(t)
	fetcher := &fakeVICFetcher{
		listingDoc: vicListingDocument(t, `<a href="`+older+`">earlier statistics</a>`),
		listingURL: mustURL(t, vicListingPageURL),
		workbooks: map[string]fakeVICWorkbookResponse{
			older:      {body: want},
			vicXLSXURL: {body: want},
		},
	}

	got, err := fetchVICSuburbWorkbook(context.Background(), fetcher)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("workbook = %q, want pinned fallback", got)
	}
	if len(fetcher.byteCalls) != 1 || fetcher.byteCalls[0] != vicXLSXURL {
		t.Fatalf("workbook calls = %v, want only pinned fallback; older discovery must not be fetched", fetcher.byteCalls)
	}
}

func TestFetchVICSuburbWorkbookFallsBackWithoutFetchingSameYearDiscoveredWorkbook(t *testing.T) {
	sameYear := "https://www.land.vic.gov.au/__data/archive/houses-by-suburb-2010-2024.xlsx"
	want := vicFixture(t)
	fetcher := &fakeVICFetcher{
		listingDoc: vicListingDocument(t, `<a href="`+sameYear+`">alternate archive</a>`),
		listingURL: mustURL(t, vicListingPageURL),
		workbooks: map[string]fakeVICWorkbookResponse{
			sameYear:   {body: want},
			vicXLSXURL: {body: want},
		},
	}

	if _, err := fetchVICSuburbWorkbook(context.Background(), fetcher); err != nil {
		t.Fatal(err)
	}
	if len(fetcher.byteCalls) != 1 || fetcher.byteCalls[0] != vicXLSXURL {
		t.Fatalf("workbook calls = %v, want only pinned fallback when discovery does not advance the end year", fetcher.byteCalls)
	}
}

func TestFetchVICSuburbWorkbookFallsBackWhenDiscoveredAssetIsNotXLSX(t *testing.T) {
	discovered := "https://www.land.vic.gov.au/__data/houses-by-suburb-2015-2025.xlsx"
	want := vicFixture(t)
	fetcher := &fakeVICFetcher{
		listingDoc: vicListingDocument(t, `<a href="`+discovered+`">workbook</a>`),
		listingURL: mustURL(t, vicListingPageURL),
		workbooks: map[string]fakeVICWorkbookResponse{
			discovered: {body: []byte("challenge page")},
			vicXLSXURL: {body: want},
		},
	}

	got, err := fetchVICSuburbWorkbook(context.Background(), fetcher)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("workbook = %q, want %q", got, want)
	}
	wantCalls := []string{discovered, vicXLSXURL}
	if strings.Join(fetcher.byteCalls, "\n") != strings.Join(wantCalls, "\n") {
		t.Fatalf("workbook calls = %v, want %v", fetcher.byteCalls, wantCalls)
	}
}

func TestFetchVICSuburbWorkbookFallsBackWhenDiscoveredPKPayloadIsNotXLSX(t *testing.T) {
	discovered := "https://www.land.vic.gov.au/__data/houses-by-suburb-2015-2025.xlsx"
	for _, tc := range []struct {
		name string
		body []byte
	}{
		{name: "malformed zip", body: []byte("PK corrupt zip payload")},
		{name: "unrelated zip", body: vicZIPFixture(t, "readme.txt", []byte("not an xlsx"))},
		{name: "named garbage zip", body: vicNamedGarbageXLSXFixture(t)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			want := vicFixture(t)
			fetcher := &fakeVICFetcher{
				listingDoc: vicListingDocument(t, `<a href="`+discovered+`">workbook</a>`),
				listingURL: mustURL(t, vicListingPageURL),
				workbooks: map[string]fakeVICWorkbookResponse{
					discovered: {body: tc.body},
					vicXLSXURL: {body: want},
				},
			}

			got, err := fetchVICSuburbWorkbook(context.Background(), fetcher)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, want) {
				t.Fatalf("workbook = %q, want valid fallback workbook", got)
			}
			wantCalls := []string{discovered, vicXLSXURL}
			if strings.Join(fetcher.byteCalls, "\n") != strings.Join(wantCalls, "\n") {
				t.Fatalf("workbook calls = %v, want %v", fetcher.byteCalls, wantCalls)
			}
		})
	}
}

func TestFetchVICSuburbWorkbookCombinesDiscoveredAndFallbackErrors(t *testing.T) {
	discovered := "https://www.land.vic.gov.au/__data/houses-by-suburb-2015-2025.xlsx"
	fetcher := &fakeVICFetcher{
		listingDoc: vicListingDocument(t, `<a href="`+discovered+`">workbook</a>`),
		listingURL: mustURL(t, vicListingPageURL),
		workbooks: map[string]fakeVICWorkbookResponse{
			discovered: {err: errors.New("latest download failed")},
			vicXLSXURL: {err: errors.New("fallback download failed")},
		},
	}

	_, err := fetchVICSuburbWorkbook(context.Background(), fetcher)
	if err == nil {
		t.Fatal("expected combined fetch error")
	}
	for _, want := range []string{"latest download failed", "fallback download failed", discovered, vicXLSXURL} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not contain %q", err, want)
		}
	}
}

func vicFixture(t *testing.T) []byte {
	t.Helper()
	f := excelize.NewFile()
	sh := f.GetSheetName(0)
	set := func(cell string, value any) {
		t.Helper()
		if err := f.SetCellValue(sh, cell, value); err != nil {
			t.Fatalf("set %s: %v", cell, err)
		}
	}
	// header: Locality + scattered year columns (mimics the real wide layout)
	set("A1", "Locality")
	set("C1", "2020")
	set("E1", "2021")
	// data rows
	set("A2", "ABBOTSFORD")
	set("C2", 862500)
	set("E2", 925000)
	set("A3", "TESTBURG")
	set("C3", "-")         // no data -> skip
	set("E3", "^ 595000")  // low-count footnote -> preliminary
	set("A4", "1,234,000") // a numeric-looking non-suburb row label is fine; only data cols read
	var buf bytes.Buffer
	if err := f.Write(&buf); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestParseVICSuburbMedians(t *testing.T) {
	obs, err := parseVICSuburbMedians(vicFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	get := func(region string, year int) (Observation, bool) {
		for _, o := range obs {
			if o.RegionCode == region && o.Period.Year() == year {
				return o, true
			}
		}
		return Observation{}, false
	}

	ab2020, ok := get("SUBURB:VIC-ABBOTSFORD", 2020)
	if !ok || ab2020.Value != 862500 || ab2020.StateCode != "VIC" || ab2020.Measure != "median_price" ||
		ab2020.DwellingType != "house" || ab2020.PeriodFreq != "A" || ab2020.Source != "vg_vic" {
		t.Errorf("ABBOTSFORD 2020: %+v ok=%v", ab2020, ok)
	}
	if ab2020.Period != time.Date(2020, 12, 31, 0, 0, 0, 0, time.UTC) {
		t.Errorf("annual period should be year-end, got %v", ab2020.Period)
	}
	tb2021, ok := get("SUBURB:VIC-TESTBURG", 2021)
	if !ok || tb2021.Value != 595000 || !tb2021.IsPreliminary {
		t.Errorf("TESTBURG 2021 (^595000): %+v ok=%v want 595000 preliminary", tb2021, ok)
	}
	if _, ok := get("SUBURB:VIC-TESTBURG", 2020); ok {
		t.Errorf("TESTBURG 2020 was '-', should be skipped")
	}
}

// TestLiveVICSmoke hits the real CF-challenged land.vic.gov.au via stealthhttp.
// Gated behind RUN_LIVE=1.
func TestLiveVICSmoke(t *testing.T) {
	if os.Getenv("RUN_LIVE") != "1" {
		t.Skip("set RUN_LIVE=1 to hit the live VIC fetch")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	obs, err := ingestVICSuburbMedians(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) < 1000 {
		t.Fatalf("expected many VIC suburb-year medians, got %d", len(obs))
	}
	t.Logf("live VIC: %d suburb-year observations", len(obs))
}
