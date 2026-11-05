package reportextract

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	_ "time/tzdata" // Sydney's calendar day, wherever the binary runs
)

// asxAPIBase is ASX's current announcements API, the one its own research
// pages read. It answers for the codes ASX still lists: a code it does not
// know (delisted, renamed) is "Symbol not found".
const asxAPIBase = "https://asx.api.markitdigital.com/asx-research/1.0"

// asxAPIListCount is the size the list asks for. The API does not honour it:
// on 2026-11-05 BHP's list answered 5 items for count=200, count=20 and
// itemsPerPage=50 alike, so the size of a list is never read as a fact. What a
// list shows is decided by how far back its oldest item reaches (matchAnnouncement).
const asxAPIListCount = 200

// ErrASXCodeUnknown is the API's answer for a code it does not list.
var ErrASXCodeUnknown = errors.New("ASX's announcements API does not know the code")

// ErrASXNotListed is a listed code whose announcements carry no item with the
// notice's day and headline, two different documents for it, or a list too
// short to show whether the day is complete (withheld, not guessed).
var ErrASXNotListed = errors.New("no matching announcement in ASX's announcements API")

// ErrASXListCut is ErrASXNotListed for a list that does not reach back before
// the notice's day: its oldest item falls on that day or later, so the list may
// hold only some of the day's announcements. Nothing is ruled out, so it is not
// ASX's answer that the document is missing, and a caller must not read it as one.
var ErrASXListCut = fmt.Errorf("%w: the list is cut before the day", ErrASXNotListed)

// ErrASXUnreadable is the answer when the list holds an announcement the API
// does not let us match or download on the notice's day, or an announcement
// with no date at all: a same-day item with the notice's headline (or none)
// with no document key may be the notice itself, and an undated item cannot be
// placed on any day. Nothing is ruled out, so, like ErrASXListCut, it is no
// answer about the document.
var ErrASXUnreadable = errors.New("the list holds a same-day announcement the API cannot match or download")

// ErrASXNoCode is the answer when none of the codes a notice is listed under is
// a well-formed ASX code, so the API is never asked. It is no answer about the
// notice, and a caller must not read it as one.
var ErrASXNoCode = errors.New("no well-formed ASX code to ask the announcements API about")

// asxAPIPace is the least gap between two requests to the API, shared by every
// worker of a run: a notice can cost a list and a file request back to back, so
// a per-notice pause alone would let three workers burst past ASX's own pages.
const asxAPIPace = 400 * time.Millisecond

// asxAPIRunCap bounds the requests (lists and files) one run makes to the API.
// A notice costs at most one file request and each code one list request, so
// the cap is far above a 400-notice run and stops a runaway loop, not a run.
const asxAPIRunCap = 600

// ErrASXAPIBudget is the answer once a run has spent its API requests. It is a
// transport-class failure: the notice stays fetch_error and is read next run.
var ErrASXAPIBudget = errors.New("announcements API request cap reached for this run")

var (
	asxCodeRe = regexp.MustCompile(`^[A-Z0-9]{2,6}$`)
	asxKeyRe  = regexp.MustCompile(`^[A-Za-z0-9-]{1,80}$`)
)

// asxAPIHeaders are the browser-shaped headers ASX's own pages send to the
// API; the origin and referer are what it checks.
var asxAPIHeaders = map[string]string{
	"User-Agent": asxHeaders["User-Agent"],
	"Accept":     "application/json",
	"Origin":     "https://www.asx.com.au",
	"Referer":    "https://www.asx.com.au/",
}

// apiAnnouncement is one item of a company's announcements list. Unreadable is
// an item the API lists without a headline or a document key; it cannot be
// downloaded, but it still counts for the day it falls on (matchAnnouncement).
// An undated item has the zero Date and is kept for the same reason.
type apiAnnouncement struct {
	Date        time.Time
	Headline    string
	DocumentKey string
	Unreadable  bool
}

// apiListing is a company's announcements as the API answered them, newest
// first. The API lists only as many as it chooses, so a list may not reach back
// before a notice's day, and then it may hold only some of that day's
// announcements.
type apiListing struct {
	Items []apiAnnouncement
}

// listFetch is one company's list request while it is in flight. Workers that
// need the same list wait for it rather than asking the API again.
type listFetch struct {
	done    chan struct{}
	listing apiListing
	err     error
}

// announcementAPI reads ASX's announcements API. A company's list is read at
// most once per run, so a code with many set-aside notices costs one request.
type announcementAPI struct {
	client *http.Client
	base   string
	runCap int // requests allowed for the run (asxAPIRunCap)

	pace time.Duration // least gap between two requests (asxAPIPace)

	mu       sync.Mutex
	lists    map[string]apiListing // a code's list, once read
	inflight map[string]*listFetch // a code's list request, while it is under way
	gone     map[string]bool       // a code the API does not know
	requests int                   // requests made so far this run
	nextAt   time.Time             // the earliest start of the next request
	refused  error                 // the first refusal (401, 403, 429): no request is made after it
}

func newAnnouncementAPI(client *http.Client, base string) *announcementAPI {
	return &announcementAPI{client: client, base: base, runCap: asxAPIRunCap, pace: asxAPIPace,
		lists: map[string]apiListing{}, inflight: map[string]*listFetch{}, gone: map[string]bool{}}
}

// AnnouncementPDF returns the PDF of the announcement a company lists on day
// (YYYY-MM-DD, Sydney's calendar day) with the given headline. It asks each of
// the codes in turn, sorted, and downloads the first match. A code the API
// does not know is skipped; when every code is unknown the answer is
// ErrASXCodeUnknown, and when no code is well-formed it is ErrASXNoCode (the
// API is not asked). A transport failure for any code wins over "not listed",
// so a retry is not turned into a set-aside; and a list cut before the day
// (ErrASXListCut) wins over "not listed", since a cut list may hold the document.
func (a *AnnouncementTextFetcher) AnnouncementPDF(ctx context.Context, codes []string, day, headline string) ([]byte, error) {
	return a.api.pdf(ctx, codes, day, headline)
}

func (a *announcementAPI) pdf(ctx context.Context, codes []string, day, headline string) ([]byte, error) {
	var ucodes []string
	for _, code := range uniqueSortedCodes(codes) {
		if asxCodeRe.MatchString(code) {
			ucodes = append(ucodes, code)
		}
	}
	if len(ucodes) == 0 {
		return nil, ErrASXNoCode
	}
	var unknown, cut, unreadable int
	var transport error
	for _, code := range ucodes {
		listing, err := a.list(ctx, code)
		switch {
		case errors.Is(err, ErrASXCodeUnknown):
			unknown++
			continue
		case err != nil:
			transport = errors.Join(transport, fmt.Errorf("%s: %w", code, err))
			continue
		}
		item, err := matchAnnouncement(listing, day, headline)
		if errors.Is(err, ErrASXListCut) {
			cut++
			continue
		}
		if errors.Is(err, ErrASXUnreadable) {
			unreadable++
			continue
		}
		if err != nil {
			continue
		}
		return a.file(ctx, item.DocumentKey)
	}
	switch {
	case transport != nil:
		return nil, transport
	case cut > 0:
		// A list cut before the day may hold the document, so no code's answer
		// settles it, whatever the other lists said.
		return nil, ErrASXListCut
	case unreadable > 0:
		// An announcement the list cannot show us may be the document, so no
		// code's answer settles it either.
		return nil, ErrASXUnreadable
	case unknown == len(ucodes):
		return nil, ErrASXCodeUnknown
	default:
		return nil, ErrASXNotListed
	}
}

// list returns a code's most recent announcements. The run keeps each list it
// reads, and a list still in flight is waited for, so concurrent workers that
// need the same code cost one request.
func (a *announcementAPI) list(ctx context.Context, code string) (apiListing, error) {
	code = strings.ToUpper(strings.TrimSpace(code))
	if !asxCodeRe.MatchString(code) {
		return apiListing{}, ErrASXNoCode
	}
	a.mu.Lock()
	if l, ok := a.lists[code]; ok {
		a.mu.Unlock()
		return l, nil
	}
	if a.gone[code] {
		a.mu.Unlock()
		return apiListing{}, ErrASXCodeUnknown
	}
	if f, ok := a.inflight[code]; ok {
		a.mu.Unlock()
		select {
		case <-f.done:
			return f.listing, f.err
		case <-ctx.Done():
			return apiListing{}, ctx.Err()
		}
	}
	f := &listFetch{done: make(chan struct{})}
	a.inflight[code] = f
	a.mu.Unlock()

	f.listing, f.err = a.fetchList(ctx, code)

	a.mu.Lock()
	if f.err == nil {
		a.lists[code] = f.listing
	}
	delete(a.inflight, code)
	a.mu.Unlock()
	close(f.done)
	return f.listing, f.err
}

// fetchList asks the API for a code's list once.
func (a *announcementAPI) fetchList(ctx context.Context, code string) (apiListing, error) {
	endpoint := fmt.Sprintf("%s/companies/%s/announcements?count=%d", a.base, code, asxAPIListCount)
	body, status, err := a.get(ctx, endpoint, "application/json")
	if err != nil {
		return apiListing{}, err
	}
	if bytes.Contains(body, []byte("Symbol not found")) {
		a.mu.Lock()
		a.gone[code] = true
		a.mu.Unlock()
		return apiListing{}, ErrASXCodeUnknown
	}
	if status != http.StatusOK {
		return apiListing{}, &StatusError{Code: status}
	}
	items, _, err := parseAnnouncementList(body)
	if err != nil {
		return apiListing{}, fmt.Errorf("%s: %w", code, err)
	}
	return apiListing{Items: items}, nil
}

// file downloads one announcement's document. It answers application/pdf.
func (a *announcementAPI) file(ctx context.Context, documentKey string) ([]byte, error) {
	if !asxKeyRe.MatchString(documentKey) {
		return nil, fmt.Errorf("document key %q is not an ASX document key", documentKey)
	}
	body, status, err := a.get(ctx, a.base+"/file/"+url.PathEscape(documentKey), "application/pdf,*/*")
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, &StatusError{Code: status}
	}
	if !bytes.HasPrefix(body, pdfMagic) {
		return nil, fmt.Errorf("not a PDF response")
	}
	return body, nil
}

// get issues one GET with the API headers and returns the body (bounded) and
// the status. The body is read for every status, because the API says
// "Symbol not found" on a 400. A refusal (401, 403, 429) ends the API for the
// rest of the run, and the run's request cap is checked before each request.
func (a *announcementAPI) get(ctx context.Context, endpoint, accept string) ([]byte, int, error) {
	a.mu.Lock()
	switch {
	case a.refused != nil:
		err := a.refused
		a.mu.Unlock()
		return nil, 0, err
	case a.requests >= a.runCap:
		a.mu.Unlock()
		return nil, 0, ErrASXAPIBudget
	}
	a.requests++
	// Reserve this request's start: the slot after the previous one, or now.
	start := time.Now()
	if a.nextAt.After(start) {
		start = a.nextAt
	}
	a.nextAt = start.Add(a.pace)
	a.mu.Unlock()
	if wait := time.Until(start); wait > 0 {
		t := time.NewTimer(wait)
		select {
		case <-t.C:
		case <-ctx.Done():
			t.Stop()
			return nil, 0, ctx.Err()
		}
	}

	ctx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, 0, err
	}
	for k, v := range asxAPIHeaders {
		req.Header.Set(k, v)
	}
	req.Header.Set("Accept", accept)
	resp, err := a.client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxPDFBytes))
	if err != nil {
		return nil, 0, err
	}
	if IsRefusal(&StatusError{Code: resp.StatusCode}) {
		a.mu.Lock()
		if a.refused == nil {
			a.refused = &StatusError{Code: resp.StatusCode}
		}
		a.mu.Unlock()
	}
	return body, resp.StatusCode, nil
}

// parseAnnouncementList reads the API's list, and returns how many items the
// API listed. An item without a headline or a document key is kept as
// Unreadable: it cannot be downloaded, but it may be a notice of the day it falls
// on. An item without a date is kept with the zero Date, which matchAnnouncement
// reads as unplaceable. Every item counts as listed.
func parseAnnouncementList(body []byte) ([]apiAnnouncement, int, error) {
	var doc struct {
		Data struct {
			Items []struct {
				Date        string `json:"date"`
				Headline    string `json:"headline"`
				DocumentKey string `json:"documentKey"`
			} `json:"items"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, 0, fmt.Errorf("announcements list: %w", err)
	}
	out := make([]apiAnnouncement, 0, len(doc.Data.Items))
	for _, it := range doc.Data.Items {
		at, err := time.Parse(time.RFC3339Nano, it.Date)
		if err != nil {
			at = time.Time{}
		}
		out = append(out, apiAnnouncement{Date: at, Headline: it.Headline, DocumentKey: it.DocumentKey,
			Unreadable: it.Headline == "" || it.DocumentKey == ""})
	}
	return out, len(doc.Data.Items), nil
}

var sydneyLocation = sync.OnceValues(func() (*time.Location, error) {
	return time.LoadLocation("Australia/Sydney")
})

// matchAnnouncement returns the item dated day (YYYY-MM-DD, read as Sydney's
// calendar day: the API's timestamps are UTC) whose headline equals headline
// after whitespace is folded. ErrASXNotListed when none matches or when two
// different documents do. ErrASXListCut when the list does not reach back before
// day, whatever its size: the API holds only its newest items, so a notice on
// that day may be missing and another holder's notice of the same headline could
// be the only match. ErrASXUnreadable when an item the list cannot download may
// be the notice: an undated item, or an item of the day with the headline or with
// no headline and no document key.
//
// The match is by headline and day alone; the API's document keys carry no
// identity the notice's own URL shows (its display idsId names another document),
// so a list that covers the day but lacks the notice's own document still matches
// another holder's notice of the same headline. The caller guards that with the
// notices the feed holds on the day (noticePass.fetch).
func matchAnnouncement(l apiListing, day, headline string) (apiAnnouncement, error) {
	loc, err := sydneyLocation()
	if err != nil {
		return apiAnnouncement{}, fmt.Errorf("sydney time zone: %w", err)
	}
	if !reachesBefore(l.Items, loc, day) {
		return apiAnnouncement{}, ErrASXListCut
	}
	want := foldSpace(headline)
	var found []apiAnnouncement
	for _, it := range l.Items {
		switch {
		case it.Date.IsZero():
			return apiAnnouncement{}, ErrASXUnreadable
		case it.Date.In(loc).Format("2006-01-02") != day:
			continue
		case it.Unreadable && (it.Headline == "" || foldSpace(it.Headline) == want):
			return apiAnnouncement{}, ErrASXUnreadable
		case !it.Unreadable && foldSpace(it.Headline) == want:
			found = append(found, it)
		}
	}
	keys := map[string]bool{}
	for _, it := range found {
		keys[it.DocumentKey] = true
	}
	if len(keys) != 1 {
		return apiAnnouncement{}, ErrASXNotListed
	}
	return found[0], nil
}

// reachesBefore reports whether the oldest dated item is dated (Sydney's calendar
// day) before day. A list cut at its newest items holds every announcement
// later than its oldest one, so when it reaches before day, every announcement
// of day is in it. An undated item is placed nowhere and is not the oldest. An
// empty list reaches nothing.
func reachesBefore(items []apiAnnouncement, loc *time.Location, day string) bool {
	oldest := ""
	for _, it := range items {
		if it.Date.IsZero() {
			continue
		}
		if d := it.Date.In(loc).Format("2006-01-02"); oldest == "" || d < oldest {
			oldest = d
		}
	}
	return oldest != "" && oldest < day
}

// foldSpace collapses runs of whitespace, and trims it at both ends.
func foldSpace(s string) string { return strings.Join(strings.Fields(s), " ") }

func uniqueSortedCodes(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, c := range in {
		c = strings.ToUpper(strings.TrimSpace(c))
		if c != "" && !seen[c] {
			seen[c] = true
			out = append(out, c)
		}
	}
	sort.Strings(out)
	return out
}
