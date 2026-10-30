package main

import (
	"errors"
	"regexp"
	"testing"

	"github.com/mxschmitt/playwright-go"
)

// fakeJar is a cookie jar that applies a ClearCookies domain filter the way Playwright does: the
// regex is matched against each cookie's domain. It records the filters it was asked to apply.
type fakeJar struct {
	cookies []playwright.Cookie
	filters []*regexp.Regexp
	failErr error
}

func (j *fakeJar) Cookies(urls ...string) ([]playwright.Cookie, error) {
	if j.failErr != nil {
		return nil, j.failErr
	}
	return append([]playwright.Cookie(nil), j.cookies...), nil
}

func (j *fakeJar) ClearCookies(options ...playwright.BrowserContextClearCookiesOptions) error {
	if len(options) != 1 {
		return errors.New("want one options value")
	}
	re, ok := options[0].Domain.(*regexp.Regexp)
	if !ok {
		return errors.New("domain filter must be a regexp")
	}
	j.filters = append(j.filters, re)
	var kept []playwright.Cookie
	for _, c := range j.cookies {
		if !re.MatchString(c.Domain) {
			kept = append(kept, c)
		}
	}
	j.cookies = kept
	return nil
}

// The reset deletes Domain's cookies and nothing else. realestate.com.au's Kasada clearance, and
// look-alike domains, stay.
func TestClearDomainCookiesDeletesOnlyDomain(t *testing.T) {
	jar := &fakeJar{cookies: []playwright.Cookie{
		{Name: "_abck", Domain: ".domain.com.au"},
		{Name: "bm_sz", Domain: "www.domain.com.au"},
		{Name: "ak_bmsc", Domain: "domain.com.au"},
		{Name: "_abck", Domain: ".realestate.com.au"},
		{Name: "kpsdk", Domain: ".realestate.com.au"},
		{Name: "x", Domain: "notdomain.com.au"},
		{Name: "y", Domain: "domain.com.au.example.net"},
		{Name: "z", Domain: ".kasada.io"},
	}}
	n, err := clearDomainCookiesFrom(jar)
	if err != nil {
		t.Fatalf("clear: %v", err)
	}
	if n != 3 {
		t.Fatalf("deleted %d cookie(s), want 3", n)
	}
	if len(jar.filters) != 1 {
		t.Fatalf("want exactly one ClearCookies call, got %d", len(jar.filters))
	}
	if len(jar.cookies) != 5 {
		t.Fatalf("kept %d cookie(s), want 5", len(jar.cookies))
	}
	for _, c := range jar.cookies {
		if isDomainCookieDomain(c.Domain) {
			t.Fatalf("a domain.com.au cookie survived: %+v", c)
		}
	}
}

// With no Domain cookies the jar is not touched at all.
func TestClearDomainCookiesNoOpWhenNone(t *testing.T) {
	jar := &fakeJar{cookies: []playwright.Cookie{{Name: "kpsdk", Domain: ".realestate.com.au"}}}
	n, err := clearDomainCookiesFrom(jar)
	if err != nil || n != 0 {
		t.Fatalf("n=%d err=%v, want 0 and nil", n, err)
	}
	if len(jar.filters) != 0 {
		t.Fatalf("ClearCookies must not run when there is nothing to delete")
	}
}

func TestDomainCookieDomainMatch(t *testing.T) {
	cases := map[string]bool{
		".domain.com.au":            true,
		"domain.com.au":             true,
		"WWW.Domain.com.au":         true,
		"realestate.com.au":         false,
		"notdomain.com.au":          false,
		"domain.com.au.example.net": false,
		"":                          false,
	}
	for d, want := range cases {
		if got := isDomainCookieDomain(d); got != want {
			t.Errorf("isDomainCookieDomain(%q) = %v, want %v", d, got, want)
		}
	}
}

// fakeDomainFetcher is a fetcher that offers the reset. The embedded nil htmlFetcher is never used.
type fakeDomainFetcher struct {
	htmlFetcher
	calls int
	err   error
}

func (f *fakeDomainFetcher) clearDomainCookies() (int, error) {
	f.calls++
	return 2, f.err
}

// The reset runs only with the collector managing a loopback dedicated Chrome, and only on a fetcher
// that offers it. Every other run leaves the profile alone.
func TestResetDomainSessionOnTripGates(t *testing.T) {
	cases := []struct {
		name     string
		autoWarm string
		cdpURL   string
		fetcher  htmlFetcher
		want     int
	}{
		{"cdp, managed, loopback: resets", "true", "http://127.0.0.1:9333", &fakeDomainFetcher{}, 1},
		{"auto warm off: never", "false", "http://127.0.0.1:9333", &fakeDomainFetcher{}, 0},
		{"remote CDP: never", "true", "http://10.0.0.5:9333", &fakeDomainFetcher{}, 0},
		{"fetcher without the reset: nothing to clean", "true", "http://127.0.0.1:9333", nil, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("CRAWL_AUTO_WARM", tc.autoWarm)
			captureLog(t)
			resetDomainSessionOnTrip(tc.fetcher, tc.cdpURL)
			if f, ok := tc.fetcher.(*fakeDomainFetcher); ok && f.calls != tc.want {
				t.Fatalf("reset calls = %d, want %d", f.calls, tc.want)
			}
		})
	}
}

// A failed reset is logged and returns; it never panics or fails the round.
func TestResetDomainSessionFailureIsLogged(t *testing.T) {
	t.Setenv("CRAWL_AUTO_WARM", "true")
	buf := captureLog(t)
	f := &fakeDomainFetcher{err: errors.New("driver stalled (test)")}
	resetDomainSessionOnTrip(f, "http://127.0.0.1:9333")
	if f.calls != 1 {
		t.Fatalf("the reset must be attempted once, got %d", f.calls)
	}
	if !regexp.MustCompile(`domain session reset failed`).MatchString(buf.String()) {
		t.Fatalf("the failure must be logged, got %q", buf.String())
	}
}
