package ownership

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/reportextract"
)

func TestFoldCompanyName(t *testing.T) {
	same := [][2]string{
		{"ZIP CO LIMITED", "Zip Co Ltd"},
		{"ARB Corporation Ltd", "ARB Corporation Limited"},
		{"Macquarie Group Limited", "MACQUARIE GROUP LTD"},
		{"Wildcat Resources Limited ( WC8 )", "Wildcat Resources Limited"},
		{"Domino's Pizza Enterprises Limited", "Dominos Pizza Enterprises Ltd"},
		{"Acme Holdings Pty Ltd", "ACME PTY LTD"},
		{"Mineral Resources Limited.", "mineral resources limited"},
	}
	for _, pair := range same {
		a, b := foldCompanyName(pair[0]), foldCompanyName(pair[1])
		if a == "" || a != b {
			t.Errorf("foldCompanyName(%q) = %q, (%q) = %q: want equal", pair[0], a, pair[1], b)
		}
	}
	differ := [][2]string{
		{"Zip Co Limited", "Zip Pay Limited"},
		{"ARB Corporation", "ARP Corporation"},
		{"Zip Co Limited", "Zip Creditcard Limited"},
	}
	for _, pair := range differ {
		if a, b := foldCompanyName(pair[0]), foldCompanyName(pair[1]); a == b {
			t.Errorf("foldCompanyName(%q) and (%q) both = %q", pair[0], pair[1], a)
		}
	}
	// Nothing but suffixes folds to nothing, and an empty name never matches.
	if got := foldCompanyName("Co Ltd"); got != "" {
		t.Errorf("foldCompanyName(suffixes only) = %q, want empty", got)
	}
}

// Two listed codes with the same company name: the live rule decides between
// them, and two live codes with that name stay ambiguous.
func TestResolveTargetByLiveCode(t *testing.T) {
	companies := map[string]company{
		"ZIP": {Code: "ZIP", Name: "Zip Co Limited"},
		"Z1P": {Code: "Z1P", Name: "Zip Co Limited"},
		"ARB": {Code: "ARB", Name: "ARB Corporation Limited"},
		"ARP": {Code: "ARP", Name: "ARB Corporation Limited"},
	}
	p := func(codes ...string) pendingNotice {
		return pendingNotice{Headline: "Change in substantial holding", ListedCodes: codes}
	}
	tests := []struct {
		name    string
		p       pendingNotice
		doc     string
		live    map[string]bool
		want    string
		wantWhy bool
	}{
		{"the one live code of the name", p("Z1P", "ZIP"), "ZIP CO LIMITED", map[string]bool{"ZIP": true}, "ZIP", false},
		{"the other live code, the other way round", p("Z1P", "ZIP"), "Zip Co Ltd", map[string]bool{"Z1P": true}, "Z1P", false},
		{"two live codes with the name stay ambiguous", p("Z1P", "ZIP"), "ZIP CO LIMITED", map[string]bool{"ZIP": true, "Z1P": true}, "", true},
		{"no live code stays ambiguous", p("Z1P", "ZIP"), "ZIP CO LIMITED", map[string]bool{}, "", true},
		{"a live code whose name does not fold to the notice's", p("Z1P", "ZIP"), "Zip Pay Limited", map[string]bool{"ZIP": true}, "", true},
		{"the same rule for ARB", p("ARB", "ARP"), "ARB Corporation Ltd", map[string]bool{"ARB": true}, "ARB", false},
	}
	for _, tc := range tests {
		got, why := resolveTarget(tc.p, tc.doc, companies, tc.live)
		if got != tc.want || (why != "") != tc.wantWhy {
			t.Errorf("%s: resolveTarget = %q (%s), want %q", tc.name, got, why, tc.want)
		}
	}
}

// scriptedPDFs answers each URL with its scripted bytes or error.
type scriptedPDFs struct {
	ok   map[string][]byte
	errs map[string]error
}

func (s scriptedPDFs) PDF(_ context.Context, url string) ([]byte, error) {
	if b, ok := s.ok[url]; ok {
		return b, nil
	}
	if e, ok := s.errs[url]; ok {
		return nil, e
	}
	return nil, errors.New("HTTP 404")
}

// fakeAPI answers the announcements API with one scripted result.
type fakeAPI struct {
	pdf   []byte
	err   error
	calls int
}

func (f *fakeAPI) AnnouncementPDF(context.Context, []string, string, string) ([]byte, error) {
	f.calls++
	return f.pdf, f.err
}

func zipNotice(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "notices", "zip_603_art_spaced_commas.txt"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// The display answer and the API answer decide the outcome. A notice's own
// display answer is recorded as it was; the API is consulted for ASX's
// cannot-display answer and for a transport failure, but never around a refusal.
func TestNoticePassFetchOutcomes(t *testing.T) {
	unavailable := fmt.Errorf("resolve: %w", reportextract.ErrASXUnavailable)
	refused := &reportextract.StatusError{Code: 403}
	transport := errors.New("dial tcp: i/o timeout")
	const url = "u"
	notice := pendingNotice{URL: url, Headline: "Becoming a substantial holder", AnnouncedOn: "2026-10-16", ListedCodes: []string{"ZIP"}}

	tests := []struct {
		name       string
		display    error
		api        *fakeAPI // nil: no API path
		resolve    bool     // resolve-unavailable rather than the nightly pass
		wantOut    string
		wantDetail string
		wantRow    bool
		wantAPI    int
	}{
		{"cannot display, not listed: set aside", unavailable, &fakeAPI{err: reportextract.ErrASXNotListed}, false, outcomeUnavailable, unavailableDetail, false, 1},
		{"cannot display, code unknown: set aside", unavailable, &fakeAPI{err: reportextract.ErrASXCodeUnknown}, false, outcomeUnavailable, unavailableDetail, false, 1},
		{"cannot display, API has it: parsed", unavailable, &fakeAPI{pdf: zipNotice(t)}, false, string(outcomeParsed), "", true, 1},
		{"cannot display, API transport failure: retried", unavailable, &fakeAPI{err: transport}, false, outcomeFetchError, unavailableDetail + "; announcements API: " + transport.Error(), false, 1},
		{"cannot display, API budget spent: retried", unavailable, &fakeAPI{err: reportextract.ErrASXAPIBudget}, false, outcomeFetchError, unavailableDetail + "; announcements API: " + reportextract.ErrASXAPIBudget.Error(), false, 1},
		{"refused: never asked around", refused, &fakeAPI{pdf: zipNotice(t)}, false, outcomeFetchError, refused.Error(), false, 0},
		{"transport failure, not listed: stays fetch_error", transport, &fakeAPI{err: reportextract.ErrASXNotListed}, false, outcomeFetchError, transport.Error() + "; announcements API: " + reportextract.ErrASXNotListed.Error(), false, 1},
		{"display 404, not listed: stays fetch_error", &reportextract.StatusError{Code: 404}, &fakeAPI{err: reportextract.ErrASXNotListed}, false, outcomeFetchError, "HTTP 404; announcements API: " + reportextract.ErrASXNotListed.Error(), false, 1},
		{"transport failure, code unknown: stays fetch_error", transport, &fakeAPI{err: reportextract.ErrASXCodeUnknown}, false, outcomeFetchError, transport.Error() + "; announcements API: " + reportextract.ErrASXCodeUnknown.Error(), false, 1},
		{"cannot display, list cut before the day: stays fetch_error", unavailable, &fakeAPI{err: reportextract.ErrASXListCut}, false, outcomeFetchError, unavailableDetail + "; announcements API: " + reportextract.ErrASXListCut.Error(), false, 1},
		{"cannot display, no well-formed code: stays fetch_error", unavailable, &fakeAPI{err: reportextract.ErrASXNoCode}, false, outcomeFetchError, unavailableDetail + "; announcements API: " + reportextract.ErrASXNoCode.Error(), false, 1},
		{"transport failure, no well-formed code: stays fetch_error", transport, &fakeAPI{err: reportextract.ErrASXNoCode}, false, outcomeFetchError, transport.Error() + "; announcements API: " + reportextract.ErrASXNoCode.Error(), false, 1},
		{"resolve: a display transport failure not listed stays fetch_error", transport, &fakeAPI{err: reportextract.ErrASXNotListed}, true, outcomeFetchError, transport.Error() + "; announcements API: " + reportextract.ErrASXNotListed.Error(), false, 1},
		{"resolve: cannot display and not listed: set aside", unavailable, &fakeAPI{err: reportextract.ErrASXNotListed}, true, outcomeUnavailable, unavailableDetail, false, 1},
		{"resolve: cannot display and API has it: parsed", unavailable, &fakeAPI{pdf: zipNotice(t)}, true, string(outcomeParsed), "", true, 1},
		{"no API path: cannot display is set aside", unavailable, nil, false, outcomeUnavailable, unavailableDetail, false, 0},
		{"no API path: transport is retried", transport, nil, false, outcomeFetchError, transport.Error(), false, 0},
	}
	for _, tc := range tests {
		store := &fakeStore{attempts: map[string]noticeAttempt{}, pending: []pendingNotice{notice}, resolvable: []pendingNotice{notice}}
		pass := &noticePass{store: store, pdfs: scriptedPDFs{errs: map[string]error{url: tc.display}},
			extractor: passthrough{}, workers: 1, logf: t.Logf}
		if tc.api != nil {
			pass.api = tc.api
		}
		var err error
		if tc.resolve {
			_, err = pass.resolve(context.Background(), 10, "2025-01-01")
		} else {
			_, err = pass.run(context.Background(), 10, "2025-01-01")
		}
		if err != nil {
			t.Fatal(err)
		}
		a, ok := store.attempts[url]
		if !ok {
			t.Errorf("%s: no attempt recorded", tc.name)
			continue
		}
		if a.Outcome != tc.wantOut || a.Detail != tc.wantDetail && !strings.HasPrefix(a.Detail, tc.wantDetail) {
			t.Errorf("%s: attempt %+v, want %s %q", tc.name, a, tc.wantOut, tc.wantDetail)
		}
		if (len(store.rows) == 1) != tc.wantRow {
			t.Errorf("%s: rows = %d, want row %v", tc.name, len(store.rows), tc.wantRow)
		}
		if tc.api != nil && tc.api.calls != tc.wantAPI {
			t.Errorf("%s: API asked %d times, want %d", tc.name, tc.api.calls, tc.wantAPI)
		}
	}
}

// resolve-unavailable selects its notices by ResolvableNotices and writes
// nothing in a dry run, but reads the API the same way.
func TestResolveUnavailableDryRunWritesNothing(t *testing.T) {
	store := &fakeStore{attempts: map[string]noticeAttempt{}, resolvable: []pendingNotice{
		{URL: "gone", Headline: "Becoming a substantial holder", AnnouncedOn: "2026-10-16", ListedCodes: []string{"ZIP"}},
	}}
	api := &fakeAPI{pdf: zipNotice(t)}
	pass := &noticePass{store: store, pdfs: scriptedPDFs{errs: map[string]error{
		"gone": fmt.Errorf("resolve: %w", reportextract.ErrASXUnavailable)}},
		api: api, extractor: passthrough{}, workers: 1, logf: t.Logf, dryRun: true}
	res, err := pass.resolve(context.Background(), 10, "2025-01-01")
	if err != nil {
		t.Fatal(err)
	}
	if res.Parsed != 1 || api.calls != 1 {
		t.Errorf("dry run: parsed %d, API asked %d times; want the notice recovered in memory", res.Parsed, api.calls)
	}
	if len(store.rows) != 0 || len(store.attempts) != 0 {
		t.Errorf("a dry run wrote %d rows and %d attempts", len(store.rows), len(store.attempts))
	}
}

// The nightly selection never picks up an unavailable notice, and the
// stale-version rule re-reads only the outcomes a version changed: a bump does
// not re-download every refusal.
func TestPendingSelectionSetsAsideUnavailable(t *testing.T) {
	if !slices.Contains(staleOutcomes(noticeParserVersion), outcomeAmbiguousTarget) {
		t.Error("an ambiguous target is not re-read when the parser changes")
	}
	if len(staleOutcomes(noticeParserVersion+1)) != 0 {
		t.Error("a version with no entry re-reads refusals")
	}
	for v, outcomes := range staleRereads {
		for _, o := range outcomes {
			if o == outcomeUnavailable || o == outcomeFetchError || o == string(outcomeNoText) {
				t.Errorf("version %d re-reads %s through the version rule", v, o)
			}
		}
	}
	if strings.Contains(pendingNoticesSQL, "'unavailable'") {
		t.Error("pendingNoticesSQL selects an unavailable notice")
	}
	if !strings.Contains(pendingNoticesSQL, "t.outcome = ANY($4::text[])") {
		t.Error("pendingNoticesSQL does not take the version's outcomes")
	}
	if !strings.Contains(resolvableNoticesSQL, "t.outcome = 'unavailable' AND t.parser_version < $3") {
		t.Error("resolvable selection does not read an unavailable notice once, by parser version")
	}
	if !strings.Contains(resolvableNoticesSQL, "EXISTS (SELECT 1 FROM asx_announcements b") {
		t.Error("resolvable selection filters the aggregated codes instead of testing every row of the notice")
	}
}

// The announcements API is asked once per notice: the nightly pass asks for a
// notice never asked before (or asked before apiPathVersion), and never again
// for one whose attempt recorded the API path; resolve-unavailable always asks.
func TestNightlyAsksTheAPIOnce(t *testing.T) {
	unavailable := fmt.Errorf("resolve: %w", reportextract.ErrASXUnavailable)
	transport := errors.New("dial tcp: i/o timeout")
	const url = "u"
	base := pendingNotice{URL: url, Headline: "Becoming a substantial holder", AnnouncedOn: "2026-10-16", ListedCodes: []string{"ZIP"}}
	with := func(outcome string, version int) pendingNotice {
		n := base
		n.PriorOutcome, n.PriorVersion = outcome, version
		return n
	}
	tests := []struct {
		name       string
		notice     pendingNotice
		display    error
		resolve    bool
		wantAPI    int
		wantOut    string
		wantDetail string
	}{
		{"a new notice is asked", base, unavailable, false, 1, outcomeUnavailable, unavailableDetail},
		{"a fetch_error from before the API path is asked", with(outcomeFetchError, 2), unavailable, false, 1, outcomeUnavailable, unavailableDetail},
		{"a fetch_error the API already answered is not asked again", with(outcomeFetchError, apiPathVersion), transport, false, 0, outcomeFetchError, transport.Error()},
		{"an unavailable the API already answered is not asked again", with(outcomeUnavailable, apiPathVersion), unavailable, false, 0, outcomeUnavailable, unavailableDetail},
		{"resolve asks for a fetch_error the nightly pass already asked", with(outcomeFetchError, apiPathVersion), transport, true, 1, outcomeFetchError, transport.Error() + "; announcements API: " + reportextract.ErrASXNotListed.Error()},
		{"a fetch_error the API never answered is asked again", with(outcomeFetchError, unansweredVersion), transport, false, 1, outcomeFetchError, transport.Error() + "; announcements API: " + reportextract.ErrASXNotListed.Error()},
	}
	for _, tc := range tests {
		store := &fakeStore{attempts: map[string]noticeAttempt{}, pending: []pendingNotice{tc.notice}, resolvable: []pendingNotice{tc.notice}}
		api := &fakeAPI{err: reportextract.ErrASXNotListed}
		pass := &noticePass{store: store, pdfs: scriptedPDFs{errs: map[string]error{url: tc.display}},
			api: api, extractor: passthrough{}, workers: 1, logf: t.Logf}
		var err error
		if tc.resolve {
			_, err = pass.resolve(context.Background(), 10, "2025-01-01")
		} else {
			_, err = pass.run(context.Background(), 10, "2025-01-01")
		}
		if err != nil {
			t.Fatal(err)
		}
		if api.calls != tc.wantAPI {
			t.Errorf("%s: API asked %d times, want %d", tc.name, api.calls, tc.wantAPI)
		}
		a := store.attempts[url]
		if a.Outcome != tc.wantOut || (tc.wantDetail != "" && !strings.HasPrefix(a.Detail, tc.wantDetail)) {
			t.Errorf("%s: attempt %+v, want %s %q", tc.name, a, tc.wantOut, tc.wantDetail)
		}
	}
}

// An outcome recorded while the API gave no answer is recorded below
// apiPathVersion, so the nightly pass asks the API for the notice on its next
// retry. An answer (listed or not, or ASX's own cannot-display) is recorded at
// apiPathVersion, so the API is not asked again.
func TestUnansweredAPIIsRecordedForTheNextNightly(t *testing.T) {
	unavailable := fmt.Errorf("resolve: %w", reportextract.ErrASXUnavailable)
	transport := errors.New("dial tcp: i/o timeout")
	const url = "u"
	notice := pendingNotice{URL: url, Headline: "Becoming a substantial holder", AnnouncedOn: "2026-10-16", ListedCodes: []string{"ZIP"}}
	tests := []struct {
		name        string
		display     error
		api         error
		wantOutcome string
		wantVersion int
		wantAPI     int
	}{
		{"run cap spent", unavailable, reportextract.ErrASXAPIBudget, outcomeFetchError, unansweredVersion, 1},
		{"API transport failure", transport, transport, outcomeFetchError, unansweredVersion, 1},
		{"API refusal", transport, &reportextract.StatusError{Code: 429}, outcomeFetchError, unansweredVersion, 1},
		{"display refusal keeps the API unasked", &reportextract.StatusError{Code: 403}, nil, outcomeFetchError, unansweredVersion, 0},
		{"not listed is an answer", transport, reportextract.ErrASXNotListed, outcomeFetchError, apiPathVersion, 1},
		{"cannot display and not listed is an answer", unavailable, reportextract.ErrASXNotListed, outcomeUnavailable, apiPathVersion, 1},
		{"unknown code with a display transport failure is an answer, not a set-aside", transport, reportextract.ErrASXCodeUnknown, outcomeFetchError, apiPathVersion, 1},
		{"cannot display and code unknown is an answer", unavailable, reportextract.ErrASXCodeUnknown, outcomeUnavailable, apiPathVersion, 1},
		{"no well-formed code is no answer", unavailable, reportextract.ErrASXNoCode, outcomeFetchError, unansweredVersion, 1},
		{"no well-formed code with a display transport failure is no answer", transport, reportextract.ErrASXNoCode, outcomeFetchError, unansweredVersion, 1},
		{"a list cut before the day is no answer about the document", unavailable, reportextract.ErrASXListCut, outcomeFetchError, unansweredVersion, 1},
		{"a same-day item the list cannot download is no answer", unavailable, reportextract.ErrASXUnreadable, outcomeFetchError, unansweredVersion, 1},
		{"a list cut with a display transport failure is no answer", transport, reportextract.ErrASXListCut, outcomeFetchError, unansweredVersion, 1},
	}
	for _, tc := range tests {
		store := &fakeStore{attempts: map[string]noticeAttempt{}, pending: []pendingNotice{notice}}
		api := &fakeAPI{err: tc.api}
		if tc.api == nil {
			api = &fakeAPI{pdf: zipNotice(t)}
		}
		pass := &noticePass{store: store, pdfs: scriptedPDFs{errs: map[string]error{url: tc.display}},
			api: api, extractor: passthrough{}, workers: 1, logf: t.Logf}
		if _, err := pass.run(context.Background(), 10, "2025-01-01"); err != nil {
			t.Fatal(err)
		}
		if got := store.attempts[url].Outcome; got != tc.wantOutcome {
			t.Errorf("%s: outcome %s, want %s", tc.name, got, tc.wantOutcome)
		}
		if got := store.versions[url]; got != tc.wantVersion {
			t.Errorf("%s: recorded at version %d, want %d", tc.name, got, tc.wantVersion)
		}
		if api.calls != tc.wantAPI {
			t.Errorf("%s: API asked %d times, want %d", tc.name, api.calls, tc.wantAPI)
		}
	}
}

// A list that is cut before the notice's day never settles the notice, on any
// night: the cut outcome is recorded as unanswered, so the next night asks again,
// and the notice is set aside only once a list reaches back before its day and
// shows no document for it. The cut answer that the first night recorded as
// fetch_error must not become unavailable on a later night from the display
// page alone.
func TestCutListNeverSetsAsideOnTheNextNight(t *testing.T) {
	unavailable := fmt.Errorf("resolve: %w", reportextract.ErrASXUnavailable)
	const url = "u"
	base := pendingNotice{URL: url, Headline: "Becoming a substantial holder", AnnouncedOn: "2026-10-16", ListedCodes: []string{"ZIP"}}
	attempts := map[string]noticeAttempt{}
	versions := map[string]int{}
	night := func(apiErr error) {
		t.Helper()
		n := base
		if a, ok := attempts[url]; ok {
			n.PriorOutcome, n.PriorVersion = a.Outcome, versions[url]
		}
		store := &fakeStore{attempts: attempts, versions: versions, pending: []pendingNotice{n}}
		api := &fakeAPI{err: apiErr}
		pass := &noticePass{store: store, pdfs: scriptedPDFs{errs: map[string]error{url: unavailable}},
			api: api, extractor: passthrough{}, workers: 1, logf: t.Logf}
		if _, err := pass.run(context.Background(), 10, "2025-01-01"); err != nil {
			t.Fatal(err)
		}
		if got := attempts[url].Outcome; got == outcomeUnavailable && apiErr != reportextract.ErrASXNotListed {
			t.Fatalf("a night whose list was cut (%v) set the notice aside", apiErr)
		}
	}
	night(reportextract.ErrASXListCut)
	if a := attempts[url]; a.Outcome != outcomeFetchError || versions[url] != unansweredVersion {
		t.Fatalf("night 1: %s at version %d, want fetch_error at %d", a.Outcome, versions[url], unansweredVersion)
	}
	night(reportextract.ErrASXListCut)
	if a := attempts[url]; a.Outcome != outcomeFetchError || versions[url] != unansweredVersion {
		t.Errorf("night 2: %s at version %d, want fetch_error at %d", a.Outcome, versions[url], unansweredVersion)
	}
	// A list that now reaches back before the day and shows no document is ASX's answer.
	night(reportextract.ErrASXNotListed)
	if a := attempts[url]; a.Outcome != outcomeUnavailable || versions[url] != apiPathVersion {
		t.Errorf("night 3: %s at version %d, want unavailable at %d", a.Outcome, versions[url], apiPathVersion)
	}
}

// A fetch_error the API already answered (recorded at apiPathVersion) is not set
// aside by the display page alone when a later retry finds the display page
// saying it cannot display the PDF. The API is not asked on that night, the
// notice stays fetch_error, and it is recorded unanswered so its next retry asks
// the API, and only the API's answer can set it aside.
func TestPriorAPIAnswerDoesNotSetAsideOnDisplayAlone(t *testing.T) {
	unavailable := fmt.Errorf("resolve: %w", reportextract.ErrASXUnavailable)
	const url = "u"
	notice := pendingNotice{URL: url, Headline: "Becoming a substantial holder", AnnouncedOn: "2026-10-16", ListedCodes: []string{"ZIP"},
		PriorOutcome: outcomeFetchError, PriorVersion: apiPathVersion}
	store := &fakeStore{attempts: map[string]noticeAttempt{}, pending: []pendingNotice{notice}}
	api := &fakeAPI{err: reportextract.ErrASXNotListed}
	pass := &noticePass{store: store, pdfs: scriptedPDFs{errs: map[string]error{url: unavailable}},
		api: api, extractor: passthrough{}, workers: 1, logf: t.Logf}
	if _, err := pass.run(context.Background(), 10, "2025-01-01"); err != nil {
		t.Fatal(err)
	}
	if api.calls != 0 {
		t.Errorf("API asked %d times on a night its answer was already recorded, want 0", api.calls)
	}
	if got := store.attempts[url].Outcome; got != outcomeFetchError {
		t.Errorf("outcome %s, want fetch_error: the display page alone must not set the notice aside", got)
	}
	if got := store.versions[url]; got != unansweredVersion {
		t.Errorf("recorded at version %d, want %d so the next retry asks the API", got, unansweredVersion)
	}
}

// Another holder's notice of the same headline on the day is in the feed, so the
// API's match could be its document: the API is not asked, and the notice is
// withheld rather than given the other holder's PDF.
func TestAnotherHoldersNoticeOfTheSameHeadlineIsWithheld(t *testing.T) {
	unavailable := fmt.Errorf("resolve: %w", reportextract.ErrASXUnavailable)
	const url = "u"
	notice := pendingNotice{URL: url, Headline: "Becoming a substantial holder", AnnouncedOn: "2026-10-16", ListedCodes: []string{"ZIP"}}
	store := &fakeStore{attempts: map[string]noticeAttempt{}, pending: []pendingNotice{notice}, shared: 2}
	api := &fakeAPI{pdf: zipNotice(t)}
	pass := &noticePass{store: store, pdfs: scriptedPDFs{errs: map[string]error{url: unavailable}},
		api: api, extractor: passthrough{}, workers: 1, logf: t.Logf}
	if _, err := pass.run(context.Background(), 10, "2025-01-01"); err != nil {
		t.Fatal(err)
	}
	if api.calls != 0 {
		t.Errorf("API asked %d times for a notice sharing its headline on the day, want 0", api.calls)
	}
	if len(store.rows) != 0 {
		t.Errorf("another holder's notice was stored under this notice's URL: %d rows", len(store.rows))
	}
	a := store.attempts[url]
	if a.Outcome != outcomeFetchError || store.versions[url] != unansweredVersion {
		t.Errorf("attempt %s at version %d, want fetch_error at %d", a.Outcome, store.versions[url], unansweredVersion)
	}
	if !strings.Contains(a.Detail, "2 notices share the day and headline") {
		t.Errorf("detail %q does not say why the API was not asked", a.Detail)
	}
}

// A notice listed under no code never reaches the API: the real fetcher answers
// ErrASXNoCode before any request, so a cannot-display page is not set aside on
// it, and the attempt is recorded as an unanswered outcome for the next run.
func TestNoListedCodeIsNoAPIAnswer(t *testing.T) {
	unavailable := fmt.Errorf("resolve: %w", reportextract.ErrASXUnavailable)
	const url = "u"
	notice := pendingNotice{URL: url, Headline: "Becoming a substantial holder", AnnouncedOn: "2026-10-16"}
	store := &fakeStore{attempts: map[string]noticeAttempt{}, pending: []pendingNotice{notice}}
	pass := &noticePass{store: store, pdfs: scriptedPDFs{errs: map[string]error{url: unavailable}},
		api: reportextract.NewAnnouncementTextFetcher(), extractor: passthrough{}, workers: 1, logf: t.Logf}
	if _, err := pass.run(context.Background(), 10, "2025-01-01"); err != nil {
		t.Fatal(err)
	}
	if got := store.attempts[url].Outcome; got != outcomeFetchError {
		t.Errorf("outcome %s, want %s: no listed code is no answer about the document", got, outcomeFetchError)
	}
	if got := store.versions[url]; got != unansweredVersion {
		t.Errorf("recorded at version %d, want %d so the next run asks again", got, unansweredVersion)
	}
}
