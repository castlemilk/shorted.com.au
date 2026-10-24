package alerts

import (
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
)

func TestUsableLogoAcceptsOnlyHTTPSRasters(t *testing.T) {
	keep := []string{
		"https://logos.test/BHP_icon.png",
		"https://logos.test/BHP_ICON.PNG",
		"https://logos.test/BHP_icon.jpg",
		"https://logos.test/BHP_icon.JPEG",
		"https://logos.test/BHP_icon.png?v=3",
	}
	for _, u := range keep {
		if got := usableLogo(u); got != u {
			t.Errorf("usableLogo(%q) = %q, want the logo kept", u, got)
		}
	}
	drop := []string{
		"",
		"https://logos.test/BHP_icon.svg",
		"https://logos.test/BHP_icon.webp",
		"https://logos.test/BHP_icon.WEBP?x=1",
		"https://logos.test/BHP",
		"https://logos.test/png-but-not-extension",
		"http://logos.test/BHP_icon.png",
		"not a url %%",
	}
	for _, u := range drop {
		if got := usableLogo(u); got != "" {
			t.Errorf("usableLogo(%q) = %q, want the monogram", u, got)
		}
	}
}

// An SVG, a WEBP, an empty logo and a wordmark-only company each draw the monogram,
// in the stock card and in the industry table.
func TestNonRasterLogosDrawTheMonogram(t *testing.T) {
	for _, logo := range []string{"", "https://logos.test/BHP.svg", "https://logos.test/BHP.webp"} {
		m := stockWithHistory()
		m.Payload.Stock.LogoURL = logo
		m.Payload.Companies[0].LogoURL = logo
		r := renderFixture(t, m)
		if strings.Contains(r.HTML, `src="https://logos.test`) {
			t.Errorf("logo %q drew a remote image", logo)
		}
		if !strings.Contains(r.HTML, `class="tile"`) {
			t.Errorf("logo %q did not draw the monogram", logo)
		}
	}

	ind := emailFixtures()["industry-above-daily"]
	ind.Payload = payload([]alertevents.Company{
		{Code: "AAA", Name: "Aaa", Latest: 6, Previous: new(float64(5)), Change: new(float64(1)), LogoURL: "https://logos.test/AAA.svg"},
		{Code: "BBB", Name: "Bbb", Latest: 6, Previous: new(float64(5)), Change: new(float64(1)), LogoURL: "https://logos.test/BBB.webp"},
	})
	r := renderFixture(t, ind)
	if strings.Contains(r.HTML, `src="https://logos.test`) {
		t.Fatal("a non-raster industry logo must not be drawn")
	}
	if strings.Count(r.HTML, `class="tile"`) != 2 {
		t.Fatal("each non-raster industry logo must draw its monogram")
	}
}
