package main

import (
	"bytes"
	"context"
	"os"
	"strconv"
	"testing"

	"github.com/PuerkitoBio/goquery"
)

// TestQLDBrisbaneBlock_Diag walks a Greater-Brisbane suburb's REA + Domain search
// pages through the SAME production fetch/extract/partition path and logs, per
// page, how many listings MATCHED the target vs the mismatch ratio that trips the
// poison gate (>0.30 ⇒ sweepBlocked). It answers whether QLD suburbs are served
// genuine poison from page 1, or whether small suburbs simply exhaust real
// inventory and the portal broadens later pages to nearby stock (which the gate
// then reads as poison, discarding the good early-page data).
//
// Diagnostic only — skipped unless QLD_DIAG_CDP_URL points at a warm Chrome
// (--remote-debugging-port with a REA startup nav already done).
func TestQLDBrisbaneBlock_Diag(t *testing.T) {
	cdp := os.Getenv("QLD_DIAG_CDP_URL")
	if cdp == "" {
		t.Skip("set QLD_DIAG_CDP_URL=http://127.0.0.1:9334 (warm Chrome) to run")
	}
	t.Setenv("CRAWL_CDP_URL", cdp)

	fetcher, err := newCrawlFetcher(loadCrawlConfig())
	if err != nil {
		t.Fatalf("newCrawlFetcher: %v", err)
	}
	defer fetcher.Close()

	// New Farm 4005 — one of the four QLD/3GBRI suburbs that reported blocked=2.
	tgt := CrawlTarget{Suburb: "new-farm", Display: "New Farm", Postcode: "4005", State: "QLD", Capital: "3GBRI"}
	ctx := context.Background()

	for _, src := range []struct {
		name  string
		urlFn func(int) string
	}{
		{"rea", tgt.reaSearchURL},
		{"domain", tgt.domainSearchURL},
	} {
		t.Logf("========== %s: %s ==========", src.name, tgt.Display)
		for page := 1; page <= 5; page++ {
			url := src.urlFn(page)
			html, _, err := fetcher.fetch(ctx, url)
			if err != nil {
				t.Logf("  p%d fetch error: %v", page, err)
				break
			}
			doc, derr := goquery.NewDocumentFromReader(bytes.NewReader(html))
			if derr != nil {
				t.Logf("  p%d parse error: %v", page, derr)
				break
			}
			raw := extractListings(doc, src.name)
			matched, mismatch := partitionByTarget(raw, tgt)

			// Sample the suburbs of the mismatched rows — is it nearby stock
			// (broadening) or generic/garbage (real poison)?
			sample := map[string]int{}
			for _, r := range raw {
				if !matchesTarget(r, tgt) {
					key := r.Suburb + " " + r.Postcode
					if key == " " {
						key = "(no suburb/postcode)"
					}
					sample[key]++
				}
			}
			t.Logf("  p%d bytes=%d raw=%d matched=%d mismatch=%.2f%s poisonGate=%v",
				page, len(html), len(raw), len(matched), mismatch,
				sampleStr(sample), mismatch > 0.30)
			if len(raw) == 0 {
				t.Logf("  p%d — 0 raw listings (likely Kasada stub / end of results)", page)
				break
			}
		}
	}
}

// TestQLDBroadenFix_Live runs the REAL production sweep (sweepSuburbSource, which
// is read-only — only diffSuburb writes) for a Greater-Brisbane suburb against a
// warm Chrome and asserts the broadening fix holds end-to-end: the sweep must NOT
// be blocked, and must retain the suburb's real early-page listings. Guarded on
// QLD_DIAG_CDP_URL, same as the diagnostic above.
func TestQLDBroadenFix_Live(t *testing.T) {
	cdp := os.Getenv("QLD_DIAG_CDP_URL")
	if cdp == "" {
		t.Skip("set QLD_DIAG_CDP_URL=http://127.0.0.1:9334 (warm Chrome) to run")
	}
	t.Setenv("CRAWL_CDP_URL", cdp)

	fetcher, err := newCrawlFetcher(loadCrawlConfig())
	if err != nil {
		t.Fatalf("newCrawlFetcher: %v", err)
	}
	defer fetcher.Close()

	tgt := CrawlTarget{Suburb: "new-farm", Display: "New Farm", Postcode: "4005", State: "QLD", Capital: "3GBRI"}
	ctx := context.Background()

	for _, src := range []struct {
		name  string
		urlFn func(int) string
	}{
		{"rea", tgt.reaSearchURL},
		{"domain", tgt.domainSearchURL},
	} {
		lc := &listingsCrawler{fetcher: fetcher, cfg: loadListingsConfig()}
		blocks := 0
		sw := lc.sweepSuburbSource(ctx, tgt, src.name, src.urlFn, &blocks)
		t.Logf("%s: status=%s collected=%d", src.name, sw.status, len(sw.listings))
		if sw.status == sweepBlocked {
			t.Errorf("%s: New Farm still blocked — broadening fix did not hold", src.name)
		}
		if len(sw.listings) == 0 {
			t.Errorf("%s: New Farm kept 0 listings — expected the real early-page set", src.name)
		}
	}
}

func sampleStr(m map[string]int) string {
	if len(m) == 0 {
		return ""
	}
	out := " mismatchedSuburbs={"
	n := 0
	for k, v := range m {
		if n >= 6 {
			out += " …"
			break
		}
		if n > 0 {
			out += ", "
		}
		out += k + "×" + strconv.Itoa(v)
		n++
	}
	return out + "}"
}
