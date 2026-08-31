package shorts

import (
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/ratelimit"
)

// The panel export is metered at more than one unit because one call does the
// work of thousands. But the HTTP middleware charges those units against the
// PER-MINUTE window as well as the monthly one — it loops Check() once per
// unit — so a cost at or above a tier's per-minute limit makes the endpoint
// reject its own first request, forever, for every caller in that tier.
//
// That is exactly what shipped: a cost of 50 against an anonymous ceiling of
// 30 returned 429 on the very first export, with rate limiting enabled as it
// is in production. Locally, where the limiter is off by default, it looked
// fine. Nothing in the unit tests could see it.
//
// Derived from DefaultConfig rather than restated, so tuning either the cost
// or a tier limit cannot silently recreate the deadlock.
func TestPanelExportCostCannotExceedAnyTiersPerMinuteLimit(t *testing.T) {
	cfg := ratelimit.DefaultConfig()

	if len(cfg.Tiers) == 0 {
		t.Fatal("no tiers configured; this test would pass vacuously")
	}

	for name, tier := range cfg.Tiers {
		// 0 means unlimited for that tier, which cannot deadlock.
		if tier.RequestsPerMinute == 0 {
			continue
		}
		if panelExportCost >= tier.RequestsPerMinute {
			t.Errorf(
				"panelExportCost (%d) >= tier %q per-minute limit (%d): a single export "+
					"would exhaust the window and 429 itself before returning any data",
				panelExportCost, name, tier.RequestsPerMinute)
		}
	}
}

// The cost must still be worth having. Metering a bulk export as one ordinary
// request would make the quota meaningless, which is the reason it is not 1.
func TestPanelExportCostIsMoreThanAnOrdinaryRequest(t *testing.T) {
	if panelExportCost <= 1 {
		t.Errorf("panelExportCost = %d; an export does far more work than one request",
			panelExportCost)
	}
}

// The lowest tier must be able to make a useful number of exports per minute,
// not just one. A caller pulling a decade in slices of a year should not have
// to wait a minute between slices.
func TestAnonymousCallersGetMoreThanOneExportPerMinute(t *testing.T) {
	cfg := ratelimit.DefaultConfig()
	anon, ok := cfg.Tiers["anonymous"]
	if !ok {
		t.Skip("no anonymous tier configured")
	}
	if anon.RequestsPerMinute == 0 {
		t.Skip("anonymous is unlimited per minute")
	}
	if got := anon.RequestsPerMinute / panelExportCost; got < 2 {
		t.Errorf("anonymous callers get %d exports per minute (limit %d / cost %d); want at least 2",
			got, anon.RequestsPerMinute, panelExportCost)
	}
}
