package main

import (
	"fmt"
	"log"
	"regexp"
	"strings"
	"time"

	"github.com/mxschmitt/playwright-go"
)

// crawl_domain_session.go resets Domain's session in the dedicated Chrome when the Domain circuit
// trips. Akamai's bot cookies (_abck, bm_sz, ak_bmsc) are set on domain.com.au and stay flagged in
// the profile, so a re-probe after the cooldown is blocked again on the same stale state. Domain has
// always loaded cold, so dropping its cookies costs nothing. realestate.com.au's cookies, which hold
// the Kasada clearance, are never touched.

// domainCookieRe matches the domain.com.au apex and its subdomains, and nothing that merely ends in
// the same letters (notdomain.com.au, domain.com.au.example.net).
var domainCookieRe = regexp.MustCompile(`(^|\.)domain\.com\.au$`)

// isDomainCookieDomain reports whether a cookie's domain (".www.domain.com.au" style) is Domain's.
func isDomainCookieDomain(d string) bool {
	return domainCookieRe.MatchString(strings.ToLower(d))
}

// cookieJar is the slice of playwright.BrowserContext the reset uses. Tests fake it.
type cookieJar interface {
	Cookies(urls ...string) ([]playwright.Cookie, error)
	ClearCookies(options ...playwright.BrowserContextClearCookiesOptions) error
}

// clearDomainCookiesFrom deletes Domain's cookies from jar and returns how many it removed. The
// delete is one ClearCookies call filtered by domainCookieRe, so nothing else in the jar is named.
// The count is the difference of the matching cookies before and after.
func clearDomainCookiesFrom(jar cookieJar) (int, error) {
	before, err := jar.Cookies()
	if err != nil {
		return 0, fmt.Errorf("list cookies: %w", err)
	}
	n := countDomainCookies(before)
	if n == 0 {
		return 0, nil
	}
	if err := jar.ClearCookies(playwright.BrowserContextClearCookiesOptions{Domain: domainCookieRe}); err != nil {
		return 0, fmt.Errorf("clear domain cookies: %w", err)
	}
	after, err := jar.Cookies()
	if err != nil {
		return 0, fmt.Errorf("re-list cookies: %w", err)
	}
	return n - countDomainCookies(after), nil
}

func countDomainCookies(cs []playwright.Cookie) int {
	n := 0
	for _, c := range cs {
		if isDomainCookieDomain(c.Domain) {
			n++
		}
	}
	return n
}

// domainCookieClearer is what a fetcher offers when it drives a browser whose session the reset
// may touch. Only the CDP fetcher, which attaches to the dedicated Chrome, implements it.
type domainCookieClearer interface {
	clearDomainCookies() (int, error)
}

// resetDomainSessionOnTrip runs when the Domain circuit opens. It acts only when the collector
// manages the dedicated Chrome (CRAWL_AUTO_WARM not false, loopback CDP) and the fetcher is the
// CDP one. Any other run has no profile of ours to clean, and a failure is logged, never fatal: the
// circuit's cooldown still applies either way.
func resetDomainSessionOnTrip(fetcher htmlFetcher, cdpURL string) {
	clearer, ok := fetcher.(domainCookieClearer)
	if !ok {
		return
	}
	if ccfg := loadChromeConfig(cdpURL); !ccfg.autoWarm || !loopbackCDP(cdpURL) {
		return
	}
	n, err := clearer.clearDomainCookies()
	if err != nil {
		log.Printf("[agent] domain session reset failed (%v) — the Domain circuit keeps its cooldown", err)
		return
	}
	log.Printf("[agent] domain session reset: deleted %d domain.com.au cookie(s) from the dedicated Chrome (other sites' cookies kept)", n)
}

// clearDomainCookies runs clearDomainCookiesFrom on the dedicated Chrome's context, under the same
// wall-clock bound as a page fetch, so a wedged driver costs the reset and not the round.
func (f *cdpFetcher) clearDomainCookies() (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	bctx := f.ctx
	if bctx == nil {
		return 0, fmt.Errorf("domain session reset: %w", errNoBrowserContext)
	}
	type result struct {
		n   int
		err error
	}
	done := make(chan result, 1)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				done <- result{0, fmt.Errorf("domain session reset panicked: %v", r)}
			}
		}()
		n, err := clearDomainCookiesFrom(bctx)
		done <- result{n, err}
	}()
	timer := time.NewTimer(f.watchdog())
	defer timer.Stop()
	select {
	case r := <-done:
		return r.n, r.err
	case <-timer.C:
		return 0, errCDPStalled
	}
}
