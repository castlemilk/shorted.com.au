package reportextract

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The display page ASX serves for an announcement it holds no PDF for: a
// short HTML shell whose text is the answer. The fixture is the body that
// www.asx.com.au's displayAnnouncement.do?display=pdf&idsId=02974436 served
// (NSB's notice of 2025-07-30) to a GET with the resolver's headers on
// 2026-11-05, byte for byte, 826 bytes. The test pins the size bound and the
// answer's text.
func TestDisplayPageUnavailableIsDefinitive(t *testing.T) {
	shell, err := os.ReadFile("testdata/asx_display_unavailable.html")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(shell, []byte("Sorry, cannot display PDF.")) || len(shell) > asxShellMaxBytes {
		t.Fatalf("fixture is %d bytes and does not carry ASX's answer", len(shell))
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(shell)
	}))
	defer srv.Close()

	f := newFetcher()
	url := srv.URL + "/asxpdf/displayAnnouncement.do?display=pdf&idsId=1"
	_, err = f.downloadPDF(context.Background(), url)
	if !errors.Is(err, ErrASXUnavailable) {
		t.Fatalf("downloadPDF error = %v, want ErrASXUnavailable", err)
	}
	if IsRefusal(err) {
		t.Error("the cannot-display answer was read as a refusal")
	}
	if got, err := f.resolveASXPDF(context.Background(), url); !errors.Is(err, ErrASXUnavailable) || got != "" {
		t.Errorf("resolveASXPDF = %q, %v; want ErrASXUnavailable", got, err)
	}
}

// A refusal of the display page is a result, and a caller must see it as one.
func TestDisplayPageRefusalIsARefusal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "forbidden", http.StatusForbidden)
	}))
	defer srv.Close()

	_, err := newFetcher().downloadPDF(context.Background(), srv.URL+"/asxpdf/displayAnnouncement.do?idsId=2")
	if !IsRefusal(err) {
		t.Fatalf("downloadPDF error = %v, want a refusal", err)
	}
	if errors.Is(err, ErrASXUnavailable) {
		t.Error("a 403 was read as the cannot-display answer")
	}
	// A server error is not a refusal: the API may still answer for it.
	if IsRefusal(&StatusError{Code: http.StatusInternalServerError}) {
		t.Error("a 500 was read as a refusal")
	}
}

func mustParse(t *testing.T, rfc3339 string) time.Time {
	t.Helper()
	at, err := time.Parse(time.RFC3339Nano, rfc3339)
	if err != nil {
		t.Fatal(err)
	}
	return at
}

func TestMatchAnnouncement(t *testing.T) {
	items := []apiAnnouncement{
		// 03:38 UTC on 22 October is 14:38 in Sydney (AEDT): the same day.
		{Date: mustParse(t, "2026-10-22T03:38:31.000Z"), Headline: "Results of 2026 Annual General Meeting", DocumentKey: "k-agm"},
		// 14:30 UTC on 21 October is 01:30 on 22 October in Sydney: the 22nd, not the 21st.
		{Date: mustParse(t, "2026-10-21T14:30:00.000Z"), Headline: "Becoming a substantial holder for CAR", DocumentKey: "k-car"},
		// Same headline, same day, a different document: two documents, withheld.
		{Date: mustParse(t, "2026-09-02T01:00:00.000Z"), Headline: "Change in substantial holding", DocumentKey: "k-one"},
		{Date: mustParse(t, "2026-09-02T02:00:00.000Z"), Headline: "Change in substantial holding", DocumentKey: "k-two"},
		// Same headline and document twice: one document, matched.
		{Date: mustParse(t, "2026-09-03T01:00:00.000Z"), Headline: "Cessation of ASX Announcement", DocumentKey: "k-dup"},
		{Date: mustParse(t, "2026-09-03T01:00:00.000Z"), Headline: "Cessation of ASX Announcement", DocumentKey: "k-dup"},
		// The list reaches back before every day tested: its oldest item is on the 30th of August.
		{Date: mustParse(t, "2026-08-30T01:00:00.000Z"), Headline: "Quarterly activity report", DocumentKey: "k-old"},
	}
	tests := []struct {
		name, day, headline, want string
		wantErr                   bool
	}{
		{"calendar day in Sydney", "2026-10-22", "Results of 2026 Annual General Meeting", "k-agm", false},
		{"the UTC day is not the day", "2026-10-21", "Results of 2026 Annual General Meeting", "", true},
		{"late UTC is the next Sydney day", "2026-10-22", "Becoming a substantial holder for CAR", "k-car", false},
		{"not the UTC day", "2026-10-21", "Becoming a substantial holder for CAR", "", true},
		{"headline whitespace folded", "2026-10-22", "  Results of 2026  Annual General Meeting\n", "k-agm", false},
		{"headline must equal", "2026-10-22", "Results of 2026 Annual General", "", true},
		{"two documents withheld", "2026-09-02", "Change in substantial holding", "", true},
		{"one document twice", "2026-09-03", "Cessation of ASX Announcement", "k-dup", false},
		{"a list whose oldest item is on the day is cut", "2026-08-30", "Quarterly activity report", "", true},
	}
	for _, tc := range tests {
		it, err := matchAnnouncement(apiListing{Items: items}, tc.day, tc.headline)
		switch {
		case tc.wantErr && !errors.Is(err, ErrASXNotListed):
			t.Errorf("%s: err = %v, want ErrASXNotListed", tc.name, err)
		case !tc.wantErr && (err != nil || it.DocumentKey != tc.want):
			t.Errorf("%s: got %q, %v; want %q", tc.name, it.DocumentKey, err, tc.want)
		}
	}
}

// A list that does not reach back before the notice's day is cut: its oldest
// item falls on the day or later, so the day may hold notices the list does not
// show. A match on that day is withheld, even when the only item the list shows
// for it is another holder's notice of the same headline, and is made once the
// list reaches back before the day. The list's size does not count: ASX answers
// 5 items for a company that asks for 200, and a 5-item list reaches back or it
// does not, as a 200-item list does.
func TestMatchAnnouncementNeedsTheWholeDay(t *testing.T) {
	const day, headline = "2026-10-22", "Becoming a substantial holder"
	// list is a company's list of size items, newest first: another holder's
	// notice of the headline on the day (a different document) at 13:00 in
	// Sydney, and fillers on the 30th. older puts a notice of the 20th in the
	// list as well, so the list reaches back before the day.
	list := func(size int, older bool) apiListing {
		items := []apiAnnouncement{{
			Date:        time.Date(2026, 10, 22, 2, 0, 0, 0, time.UTC),
			Headline:    headline,
			DocumentKey: "k-other-holder",
		}}
		fillers := size - 1
		if older {
			fillers--
			items = append(items, apiAnnouncement{
				Date:        time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC),
				Headline:    "Quarterly activity report",
				DocumentKey: "k-older",
			})
		}
		for i := 1; i <= fillers; i++ {
			items = append(items, apiAnnouncement{
				Date:        time.Date(2026, 10, 30, 0, 0, 0, 0, time.UTC).Add(-time.Duration(i) * time.Minute),
				Headline:    "Quarterly activity report",
				DocumentKey: fmt.Sprintf("k-filler-%d", i),
			})
		}
		return apiListing{Items: items}
	}
	for _, size := range []int{5, asxAPIListCount} {
		// The oldest item is on the day: cut, so withheld.
		if _, err := matchAnnouncement(list(size, false), day, headline); !errors.Is(err, ErrASXListCut) {
			t.Errorf("%d items, oldest item on the day: err = %v, want ErrASXListCut", size, err)
		}
		// A list that reaches back before the day holds every notice of the day.
		if it, err := matchAnnouncement(list(size, true), day, headline); err != nil || it.DocumentKey != "k-other-holder" {
			t.Errorf("%d items reaching before the day: got %q, %v; want k-other-holder", size, it.DocumentKey, err)
		}
		// A cut list that shows no such headline is still cut, not "not listed".
		if _, err := matchAnnouncement(list(size, false), day, "Results of 2026 Annual General Meeting"); !errors.Is(err, ErrASXListCut) {
			t.Errorf("%d items cut on the day, other headline: err = %v, want ErrASXListCut", size, err)
		}
	}
	// An empty list cannot show the day.
	if _, err := matchAnnouncement(apiListing{}, day, headline); !errors.Is(err, ErrASXListCut) {
		t.Errorf("empty list: err = %v, want ErrASXListCut", err)
	}
	// A cut list is still a not-listed answer to a caller that asks for one.
	if _, err := matchAnnouncement(list(5, false), day, headline); !errors.Is(err, ErrASXNotListed) {
		t.Errorf("cut list is not ErrASXNotListed: err = %v", err)
	}
	// A list that reaches back before the day and shows no such headline is a plain not-listed answer.
	if _, err := matchAnnouncement(list(5, true), day, "Results of 2026 Annual General Meeting"); !errors.Is(err, ErrASXNotListed) || errors.Is(err, ErrASXListCut) {
		t.Errorf("reaching list, no such headline: err = %v, want ErrASXNotListed and not ErrASXListCut", err)
	}
}

// The API's count is the items it listed, including those without a document
// key; those are kept as unreadable, so a same-day one can still withhold a match.
func TestParseAnnouncementListCountsTheItemsItListed(t *testing.T) {
	body := `{"data":{"items":[
 {"date":"2026-10-22T03:38:31.000Z","headline":"A","documentKey":"k1"},
 {"date":"2026-10-22T03:38:31.000Z","headline":"B","documentKey":""}]}}`
	items, listed, err := parseAnnouncementList([]byte(body))
	if err != nil || listed != 2 || len(items) != 2 || items[0].Unreadable || !items[1].Unreadable {
		t.Errorf("parseAnnouncementList = %+v, %d listed, %v; want two items, the second unreadable, 2 listed", items, listed, err)
	}
}

// A same-day item the list cannot download may be the notice itself, so a match
// on that day is withheld (ErrASXUnreadable), whether the item has the notice's
// headline or no headline at all. An undated item cannot be placed on any day,
// so it withholds too. An unreadable item on another day, or with another
// headline, does not.
func TestMatchAnnouncementWithholdsOnUnreadableItems(t *testing.T) {
	const day, headline = "2026-10-22", "Becoming a substantial holder"
	older := apiAnnouncement{Date: mustParse(t, "2026-10-20T01:00:00.000Z"), Headline: "Quarterly activity report", DocumentKey: "k-older"}
	readable := apiAnnouncement{Date: mustParse(t, "2026-10-22T02:00:00.000Z"), Headline: headline, DocumentKey: "k-other-holder"}
	tests := []struct {
		name    string
		items   []apiAnnouncement
		wantErr error
		want    string
	}{
		{"same headline, no key, on the day", []apiAnnouncement{older, readable, {Date: mustParse(t, "2026-10-22T03:00:00.000Z"), Headline: headline, Unreadable: true}}, ErrASXUnreadable, ""},
		{"no headline, on the day", []apiAnnouncement{older, readable, {Date: mustParse(t, "2026-10-22T03:00:00.000Z"), Unreadable: true}}, ErrASXUnreadable, ""},
		{"undated item", []apiAnnouncement{older, readable, {Headline: headline, DocumentKey: "k-undated", Unreadable: true}}, ErrASXUnreadable, ""},
		{"unreadable item on another day", []apiAnnouncement{older, readable, {Date: mustParse(t, "2026-10-21T03:00:00.000Z"), Headline: headline, Unreadable: true}}, nil, "k-other-holder"},
		{"unreadable item with another headline", []apiAnnouncement{older, readable, {Date: mustParse(t, "2026-10-22T03:00:00.000Z"), Headline: "Quarterly activity report", Unreadable: true}}, nil, "k-other-holder"},
	}
	for _, tc := range tests {
		it, err := matchAnnouncement(apiListing{Items: tc.items}, day, headline)
		switch {
		case tc.wantErr != nil && !errors.Is(err, tc.wantErr):
			t.Errorf("%s: err = %v, want %v", tc.name, err, tc.wantErr)
		case tc.wantErr != nil && errors.Is(err, ErrASXNotListed):
			t.Errorf("%s: an unreadable item was read as not listed", tc.name)
		case tc.wantErr == nil && (err != nil || it.DocumentKey != tc.want):
			t.Errorf("%s: got %q, %v; want %q", tc.name, it.DocumentKey, err, tc.want)
		}
	}
}

// Workers that need the same company's list at the same moment share one
// request: the list is asked for once, and a later notice reads it from the run.
func TestAnnouncementListIsRequestedOncePerCode(t *testing.T) {
	var lists atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/companies/BHP/announcements" {
			http.NotFound(w, r)
			return
		}
		lists.Add(1)
		time.Sleep(50 * time.Millisecond) // long enough for the other workers to arrive
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(listJSON))
	}))
	defer srv.Close()
	api := newAnnouncementAPI(srv.Client(), srv.URL)
	api.pace = 0
	a := &AnnouncementTextFetcher{api: api}
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			_, _ = a.AnnouncementPDF(context.Background(), []string{"BHP"}, "2026-10-22", "Results of 2026 Annual General Meeting")
		})
	}
	wg.Wait()
	if n := lists.Load(); n != 1 {
		t.Errorf("BHP's list was requested %d times by 8 concurrent workers, want 1", n)
	}
}

// listJSON is the announcements API's answer for a company with one notice and
// an older announcement, so the list reaches back before the notice's day.
const listJSON = `{"data":{"displayName":"BHP GROUP LIMITED","issueType":"CS","items":[
 {"announcementType":"NOTICE OF MEETING","date":"2026-10-22T03:38:31.000Z","documentKey":"2924-03151740-3A704697","fileSize":"217KB","headline":"Results of 2026 Annual General Meeting","isPriceSensitive":false,"url":""},
 {"date":"2026-10-19T21:24:35.000Z","documentKey":"","headline":"No key, skipped","url":""},
 {"date":"2026-10-01T00:00:00.000Z","documentKey":"2924-03010900-OLD","headline":"Quarterly activity report","fileSize":"90KB","url":""}
]}}`

// The API answers the way ASX's does: a list per live code, "Symbol not found"
// for a delisted one, a PDF for a document key.
func apiServer(t *testing.T, lists *atomic.Int32, listStatus int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/companies/BHP/announcements":
			lists.Add(1)
			if listStatus != http.StatusOK {
				http.Error(w, "boom", listStatus)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(listJSON))
		case "/companies/NSB/announcements":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"code":400,"message":"Bad Request: Symbol not found"}}`))
		case "/file/2924-03151740-3A704697":
			w.Header().Set("Content-Type", "application/pdf")
			_, _ = w.Write([]byte("%PDF-1.7\n% test document\n"))
		default:
			http.NotFound(w, r)
		}
	}))
}

func TestAnnouncementPDFThroughTheAPI(t *testing.T) {
	var lists atomic.Int32
	srv := apiServer(t, &lists, http.StatusOK)
	defer srv.Close()
	a := &AnnouncementTextFetcher{api: newAnnouncementAPI(srv.Client(), srv.URL)}
	ctx := context.Background()
	const day, headline = "2026-10-22", "Results of 2026 Annual General Meeting"

	// Codes are asked in sorted order: BHP matches first, so NSB is never asked
	// and the document is BHP's.
	data, err := a.AnnouncementPDF(ctx, []string{"NSB", "BHP"}, day, headline)
	if err != nil || !bytes.HasPrefix(data, pdfMagic) {
		t.Fatalf("AnnouncementPDF = %d bytes, %v; want a PDF", len(data), err)
	}
	// A second notice of BHP reads the list from this run's cache.
	if _, err := a.AnnouncementPDF(ctx, []string{"BHP"}, day, headline); err != nil {
		t.Fatal(err)
	}
	if n := lists.Load(); n != 1 {
		t.Errorf("BHP's list was read %d times, want once per run", n)
	}
	// Every code unknown (a delisted code): no document to read, so the caller sets it aside.
	if _, err := a.AnnouncementPDF(ctx, []string{"NSB"}, day, headline); !errors.Is(err, ErrASXCodeUnknown) {
		t.Errorf("unknown code err = %v, want ErrASXCodeUnknown", err)
	}
	// A listed code with no such item: not listed.
	if _, err := a.AnnouncementPDF(ctx, []string{"BHP"}, "2026-10-10", headline); !errors.Is(err, ErrASXNotListed) || errors.Is(err, ErrASXListCut) {
		t.Errorf("unlisted err = %v, want ErrASXNotListed that is not a cut", err)
	}
	// A code that is not a code is never requested, and with no code to ask the answer is ErrASXNoCode.
	if _, err := a.AnnouncementPDF(ctx, []string{"../x"}, day, headline); !errors.Is(err, ErrASXNoCode) {
		t.Errorf("malformed code err = %v, want ErrASXNoCode", err)
	}
	if _, err := a.AnnouncementPDF(ctx, nil, day, headline); !errors.Is(err, ErrASXNoCode) {
		t.Errorf("no code err = %v, want ErrASXNoCode", err)
	}
}

// A transport failure for one code is a failure, not "not listed": a retry must
// stay a retry, not become a set-aside.
func TestAnnouncementPDFTransportFailureWins(t *testing.T) {
	var lists atomic.Int32
	srv := apiServer(t, &lists, http.StatusInternalServerError)
	defer srv.Close()
	a := &AnnouncementTextFetcher{api: newAnnouncementAPI(srv.Client(), srv.URL)}
	_, err := a.AnnouncementPDF(context.Background(), []string{"BHP"}, "2026-10-22", "Results of 2026 Annual General Meeting")
	if err == nil || errors.Is(err, ErrASXNotListed) || errors.Is(err, ErrASXCodeUnknown) {
		t.Fatalf("err = %v, want a transport failure", err)
	}
	var se *StatusError
	if !errors.As(err, &se) || se.Code != http.StatusInternalServerError {
		t.Errorf("err = %v, want HTTP 500", err)
	}
}

// ASX's answer is matched after its markup is stripped, entities decoded and
// whitespace folded, so a rewording of the shell still reads as the answer, and
// a PDF or a large page never does.
func TestIsASXUnavailableFoldsTheShell(t *testing.T) {
	shell := func(msg string) []byte {
		return []byte("<!DOCTYPE html><html><head><title>ASX - Announcements</title></head><body>" +
			"<div class=\"msg\">" + msg + "</div></body></html>")
	}
	yes := map[string][]byte{
		"plain":        shell("<p>Sorry, cannot display PDF.</p>"),
		"entity space": shell("<p>Sorry,&nbsp;cannot display PDF.</p>"),
		"case":         shell("<p>SORRY, CANNOT DISPLAY PDF.</p>"),
		"tag inside":   shell("<p>Sorry, cannot <b>display</b> PDF.</p>"),
		"newlines":     shell("<p>Sorry,\r\n   cannot\n display PDF.</p>"),
	}
	for name, body := range yes {
		if !isASXUnavailable(body) {
			t.Errorf("%s: not read as ASX's answer:\n%s", name, body)
		}
	}
	no := map[string][]byte{
		"a different page":    shell("<p>Sorry, we could not find that announcement.</p>"),
		"a PDF with the text": append([]byte("%PDF-1.7\n"), shell("Sorry, cannot display PDF.")...),
		"a large page":        append(shell("<p>Sorry, cannot display PDF.</p>"), bytes.Repeat([]byte("x"), asxShellMaxBytes)...),
	}
	for name, body := range no {
		if isASXUnavailable(body) {
			t.Errorf("%s: read as ASX's answer", name)
		}
	}
}

// The API is asked no more after a refusal, and no more than the run's cap.
func TestAnnouncementAPIStopsAfterARefusalAndAtTheCap(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()
	a := &AnnouncementTextFetcher{api: newAnnouncementAPI(srv.Client(), srv.URL)}
	ctx := context.Background()
	for _, code := range []string{"BHP", "CBA", "CSL"} {
		_, err := a.AnnouncementPDF(ctx, []string{code}, "2026-10-22", "Change in substantial holding")
		if !IsRefusal(err) {
			t.Fatalf("%s: err = %v, want the refusal", code, err)
		}
	}
	if n := hits.Load(); n != 1 {
		t.Errorf("the API was asked %d times after a 429, want once", n)
	}

	var capped atomic.Int32
	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		capped.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"items":[]}}`))
	}))
	defer srv2.Close()
	b := &AnnouncementTextFetcher{api: newAnnouncementAPI(srv2.Client(), srv2.URL)}
	b.api.runCap = 2
	for _, code := range []string{"AAA", "BBB", "CCC"} {
		_, err := b.AnnouncementPDF(ctx, []string{code}, "2026-10-22", "Change in substantial holding")
		if code == "CCC" && !errors.Is(err, ErrASXAPIBudget) {
			t.Errorf("%s past the cap: err = %v, want ErrASXAPIBudget", code, err)
		}
	}
	if n := capped.Load(); n != 2 {
		t.Errorf("the API was asked %d times with a cap of 2", n)
	}
}

// ASX's list answers 5 items for a company that asks for 200. A short list whose
// oldest item falls on the notice's day is cut: the document may be among the
// day's missing items, so it is withheld and its file is never requested, even
// though the list holds another holder's notice of the same headline.
func TestShortListWithTheDayAtItsOldestIsWithheld(t *testing.T) {
	const body = `{"data":{"items":[
 {"date":"2026-10-22T03:00:00.000Z","headline":"Becoming a substantial holder","documentKey":"k-other-holder"},
 {"date":"2026-10-22T02:00:00.000Z","headline":"Quarterly activity report","documentKey":"k-q"}
]}}`
	var files atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/companies/BHP/announcements":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(body))
		case "/file/k-other-holder":
			files.Add(1)
			w.Header().Set("Content-Type", "application/pdf")
			_, _ = w.Write([]byte("%PDF-1.7\n% test document\n"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	api := newAnnouncementAPI(srv.Client(), srv.URL)
	api.pace = 0
	a := &AnnouncementTextFetcher{api: api}
	_, err := a.AnnouncementPDF(context.Background(), []string{"BHP"}, "2026-10-22", "Becoming a substantial holder")
	if !errors.Is(err, ErrASXListCut) {
		t.Errorf("err = %v, want ErrASXListCut", err)
	}
	if n := files.Load(); n != 0 {
		t.Errorf("the other holder's file was downloaded %d times for a notice the list cannot show", n)
	}
}
