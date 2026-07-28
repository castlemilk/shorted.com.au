package houseprices

import (
	"strings"
	"testing"
)

func TestReaLooksWarm(t *testing.T) {
	// A real REA listing page is ~1.17MB; build a >5000-byte fixture that
	// contains the ArgonautExchange blob without embedding megabytes of
	// fixture HTML in the test.
	warm := []byte("<html><script>window.ArgonautExchange = " + strings.Repeat(`{"a":1}`, 1000) + ";</script></html>")
	if !reaLooksWarm(warm) {
		t.Errorf("warm REA page (%d bytes, has ArgonautExchange) should be classified warm", len(warm))
	}

	// The real ~870-byte Kasada KPSDK stub the collector has actually
	// observed live for a Playwright-driven (unwarmed) navigation: no
	// ArgonautExchange, well under the size floor.
	stub := []byte(`{"status":"KPSDK_INIT","body":"` + strings.Repeat("k", 800) + `"}`)
	if reaLooksWarm(stub) {
		t.Errorf("KPSDK stub (%d bytes) should NOT be classified warm", len(stub))
	}
	if len(stub) >= reaWarmMinBytes {
		t.Fatalf("test fixture drifted: stub is %d bytes, want < %d to model the real ~870B stub", len(stub), reaWarmMinBytes)
	}

	if reaLooksWarm(nil) {
		t.Error("nil html should not be classified warm")
	}
	if reaLooksWarm([]byte{}) {
		t.Error("empty html should not be classified warm")
	}

	// Large but missing the marker (e.g. some other REA page or an
	// interstitial that pads its body) must still be NOT warm.
	bigNoMarker := []byte(strings.Repeat("x", 6000))
	if reaLooksWarm(bigNoMarker) {
		t.Error("large html without ArgonautExchange should not be classified warm")
	}

	// Small html that coincidentally contains the marker string must still be
	// NOT warm — the size floor guards against a truncated/error page that
	// happens to mention it.
	smallWithMarker := []byte("ArgonautExchange")
	if reaLooksWarm(smallWithMarker) {
		t.Error("small html, even with the marker present, should not be classified warm")
	}
}

func TestReaWarmCheckURL(t *testing.T) {
	// Must match the Bondi REA search URL this reliability fact was verified
	// against (crawl_rea_settle_test.go) and the launcher's documented fix.
	want := "https://www.realestate.com.au/buy/in-bondi,+nsw+2026/list-1"
	if got := reaWarmCheckURL(); got != want {
		t.Errorf("reaWarmCheckURL() = %q, want %q", got, want)
	}
}
