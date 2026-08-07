package main

import "testing"

// Delist safety rests entirely on sawWholeSuburb: a sweep classified complete is
// allowed to retire listings it did not see. These tests pin BOTH directions —
// the fix must let REA delist, and it must still refuse when the walk was
// genuinely truncated at the page cap.

// TestSawWholeSuburb_ReaBroadeningOnFinalPage is the regression for the measured
// defect. REA reports meta.OnTargetResults, so wantPages is sized to the exact end
// of on-target stock and broadening ALWAYS lands on the final page. Under the old
// `pages < wantPages` rule that never confirmed, so REA sweeps stayed partial and
// delisting never ran: 205 delistings across 44,630 REA listings vs 5,122 across
// 33,351 Domain ones. Measured: all 613 REA broadening stops sat at pages ==
// wantPages; zero stopped early.
func TestSawWholeSuburb_ReaBroadeningOnFinalPage(t *testing.T) {
	lc := &listingsCrawler{}
	// A typical REA suburb: portal reported ~75 on-target listings (3 pages of
	// 25), softCap 5. The walk reached page 3 and broadened there.
	if !lc.sawWholeSuburb(true, 3, 3, 5) {
		t.Fatalf("broadening on the final page, where the bound came from the portal's own on-target count (3 < cap 5), means the suburb was exhausted — must be delist-safe")
	}
}

// TestSawWholeSuburb_TruncatedAtCapIsNotSafe is the one that protects live data.
// When wantPages was CLAMPED to softCap, the walk stopped because we ran out of
// budget, not because the suburb ran out. Listings beyond the cap were never seen,
// so delisting them would retire properties that are still for sale.
func TestSawWholeSuburb_TruncatedAtCapIsNotSafe(t *testing.T) {
	lc := &listingsCrawler{}
	if lc.sawWholeSuburb(true, 5, 5, 5) {
		t.Fatalf("stopping ON the cap is truncation, not exhaustion — must NOT be delist-safe")
	}
	if lc.sawWholeSuburb(true, 10, 10, 10) {
		t.Fatalf("a dense suburb capped at 10 pages must NOT be delist-safe")
	}
}

// TestSawWholeSuburb_StoppedEarlyStillSafe keeps the original rule working. This
// is the Domain path: wantPages falls back to the broadened TotalPages, so the
// suburb runs out well before the bound.
func TestSawWholeSuburb_StoppedEarlyStillSafe(t *testing.T) {
	lc := &listingsCrawler{}
	if !lc.sawWholeSuburb(true, 2, 5, 5) {
		t.Fatalf("stopping before the bound has always meant the suburb was exhausted")
	}
	if !lc.sawWholeSuburb(true, 1, 10, 10) {
		t.Fatalf("stopping early must stay delist-safe even when the bound is the cap")
	}
}

// TestSawWholeSuburb_NoMetaIsNeverSafe covers the portal changing shape. Without
// usable PageMeta there is no evidence about extent at all, so the sweep must
// never claim completeness regardless of where it stopped.
func TestSawWholeSuburb_NoMetaIsNeverSafe(t *testing.T) {
	lc := &listingsCrawler{}
	for _, c := range []struct{ pages, want, cap int }{{1, 5, 5}, {3, 3, 5}, {5, 5, 5}} {
		if lc.sawWholeSuburb(false, c.pages, c.want, c.cap) {
			t.Fatalf("metaOK=false must never be delist-safe (pages=%d want=%d cap=%d)", c.pages, c.want, c.cap)
		}
	}
}

// TestSawWholeSuburb_KillSwitch proves CRAWL_LISTINGS_LEGACY_COMPLETENESS restores
// the old behaviour exactly, so the tier can be reverted without a deploy if the
// fix ever retires something it shouldn't.
func TestSawWholeSuburb_KillSwitch(t *testing.T) {
	legacy := &listingsCrawler{cfg: listingsConfig{legacyCompleteness: true}}
	if legacy.sawWholeSuburb(true, 3, 3, 5) {
		t.Fatalf("with the kill switch on, stopping ON the bound must fall back to NOT delist-safe")
	}
	// The switch must not disable the half of the rule that predates the fix.
	if !legacy.sawWholeSuburb(true, 2, 5, 5) {
		t.Fatalf("the kill switch must preserve the original pages < wantPages rule")
	}
}
