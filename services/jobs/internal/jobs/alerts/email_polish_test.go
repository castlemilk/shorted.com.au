package alerts

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
)

// shortStock is a stock with only three readings, the case a stock reported on its
// first days has. It must still get both charts.
func shortStock() Message {
	m := stockWithHistory()
	m.Payload.Stock.History = []alertevents.Point{
		{D: "2026-10-14", P: 5.83}, {D: "2026-10-15", P: 6.99}, {D: "2026-10-16", P: 12.15},
	}
	return m
}

func TestShortHistoryGetsBothChartsAndItsCaption(t *testing.T) {
	r := renderFixture(t, shortStock())
	if !strings.Contains(r.HTML, `src="cid:chart"`) || !strings.Contains(r.HTML, `src="cid:chart-dark"`) {
		t.Fatal("a three-reading stock must show both charts")
	}
	if !strings.Contains(r.HTML, "3 reports, 14–16 Oct 2026") {
		t.Fatal("a short history must name its report count and dates")
	}
	if strings.Contains(r.HTML, "last 6 months") || strings.Contains(r.HTML, "since first reported") {
		t.Fatal("a short history must not claim six months or since first reported")
	}
}

// A single reading has no line, so it is the one case with no chart at all.
func TestOneReadingHasNoChart(t *testing.T) {
	m := shortStock()
	m.Payload.Stock.History = m.Payload.Stock.History[2:]
	r := renderFixture(t, m)
	if strings.Contains(r.HTML, "cid:chart") || len(r.Attachments) != 1 {
		t.Fatalf("one reading must skip the chart: %d attachments", len(r.Attachments))
	}
}

// The dark chart is a second image inside a hidden wrapper, with the light one
// visible by default; the dark-mode query swaps them.
func TestDarkChartMarkup(t *testing.T) {
	r := renderFixture(t, stockWithHistory())
	for _, want := range []string{
		`class="light-chart chart-img"`,
		`class="dark-chart"`,
		`src="cid:chart-dark"`,
		`display:none;max-height:0;overflow:hidden;mso-hide:all;`,
		`.light-chart { display: none !important; }`,
		`.dark-chart { display: block !important; max-height: none !important; overflow: visible !important; }`,
	} {
		if !strings.Contains(r.HTML, want) {
			t.Errorf("HTML is missing %q", want)
		}
	}
}

// Both charts are real PNGs in the attachments, and the light and dark bytes differ.
func TestBothChartsAreAttached(t *testing.T) {
	r := renderFixture(t, stockWithHistory())
	byID := map[string]string{}
	for _, a := range r.Attachments {
		byID[a.ContentID] = a.Content
	}
	if byID["chart"] == "" || byID["chart-dark"] == "" {
		t.Fatalf("missing a chart attachment: %v", keysOf(byID))
	}
	if byID["chart"] == byID["chart-dark"] {
		t.Fatal("the dark chart must differ from the light one")
	}
}

func keysOf(m map[string]string) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}

// Every text element is set in the mono stack, the serif being for the headline only.
// Each opening tag that carries text is checked, so a new element without the stack
// fails here rather than rendering in a client's default serif.
func TestEveryTextElementIsMono(t *testing.T) {
	for name, m := range allFixtures() {
		t.Run(name, func(t *testing.T) {
			html := renderFixture(t, m).HTML
			tag := regexp.MustCompile(`<(td|th|p|div|a|body)\b[^>]*>`)
			for _, loc := range tag.FindAllStringIndex(html, -1) {
				open := html[loc[0]:loc[1]]
				if strings.Contains(open, "display:none") {
					continue // the preheader and the dark chart's wrapper show no text
				}
				if !strings.Contains(open, "IBM Plex Mono") {
					t.Fatalf("a text element is not in the mono stack: %s", open)
				}
			}
		})
	}
}

// The headline is the only serif, so it is the one element that names the serif stack.
func TestHeadlineIsTheOnlySerif(t *testing.T) {
	html := renderFixture(t, stockWithHistory()).HTML
	if n := strings.Count(html, "Newsreader"); n != 1 {
		t.Fatalf("%d elements name the serif stack, want the headline only", n)
	}
}

// The industry lookback date is the short day and month under the figure, in the
// muted mono, and the text twin keeps the full date.
func TestIndustryLookbackIsAShortDate(t *testing.T) {
	m := emailFixtures()["industry-above-daily"]
	m.Payload.Companies[0].PreviousDate = "2026-10-14"
	r := renderFixture(t, m)
	if !strings.Contains(r.HTML, ">14 Oct</div>") {
		t.Fatal("the lookback date must be the short day and month under its figure")
	}
	if !strings.Contains(r.Text, "(Wed 14 Oct 2026)") {
		t.Fatal("the text twin keeps the full dated label")
	}
}

// Mobile figures: previous and latest share a row, the change sits on its own row,
// and the stats keep two columns.
func TestMobileFigureRules(t *testing.T) {
	html := renderFixture(t, stockWithHistory()).HTML
	for _, want := range []string{
		`.fig-c { display: none !important; }`,
		`.fig-m { display: table-row !important; }`,
		`class="fig-m"`,
		`.cta-link { display: block !important; width: 100% !important;`,
	} {
		if !strings.Contains(html, want) {
			t.Errorf("mobile rule missing: %s", want)
		}
	}
	if strings.Contains(html, "stat-l { padding: 14px 14px 14px 0; }") == false {
		t.Fatal("the stats grid's desktop padding is missing")
	}
	if strings.Contains(html, ".stat-l, .stat-r { display: block") {
		t.Fatal("the stats grid must not stack on a phone")
	}
}

// Contrast floor: every text pair the email uses reaches 4.5:1 on its background,
// in both the light and the dark mode.
func TestTextContrastMeetsAA(t *testing.T) {
	pairs := []struct{ name, fg, bg string }{
		{"muted on card", mutedColor, "#FDFDFC"},
		{"muted on paper", mutedColor, "#F9F8F5"},
		{"muted on tile", mutedColor, flatChip},
		{"accent on card", "#9E5210", "#FDFDFC"},
		{"rise on rise chip", riseText, riseChip},
		{"fall on fall chip", fallText, fallChip},
		{"button text on button", "#F9F8F5", "#9E5210"},
		{"ink on card", inkColor, "#FDFDFC"},
		{"dark muted on dark", "#A39A75", "#121212"},
		{"dark ink on dark", "#E8DEB5", "#121212"},
		{"dark accent on dark", "#FFAC4D", "#121212"},
		{"dark button text on button", "#0D0D0D", "#FFAC4D"},
		{"dark rise on dark rise chip", "#F87171", "#3B1616"},
		{"dark fall on dark fall chip", "#4ADE80", "#123222"},
		{"dark flat on dark chip", "#A39A75", "#1C1915"},
	}
	for _, p := range pairs {
		if got := contrast(p.fg, p.bg); got < 4.5 {
			t.Errorf("%s: %.2f:1, want at least 4.5:1", p.name, got)
		}
	}
}

// contrast is the WCAG ratio of two #RRGGBB colours.
func contrast(a, b string) float64 {
	la, lb := luminance(a), luminance(b)
	if la < lb {
		la, lb = lb, la
	}
	return (la + 0.05) / (lb + 0.05)
}

func luminance(hex string) float64 {
	hex = strings.TrimPrefix(hex, "#")
	var c [3]float64
	for i := range c {
		v, _ := strconv.ParseUint(hex[2*i:2*i+2], 16, 8)
		f := float64(v) / 255
		if f <= 0.03928 {
			c[i] = f / 12.92
		} else {
			c[i] = math.Pow((f+0.055)/1.055, 2.4)
		}
	}
	return 0.2126*c[0] + 0.7152*c[1] + 0.0722*c[2]
}

// The text twin names the company near the top, as the first line after the subject.
func TestTextTwinNamesTheCompany(t *testing.T) {
	r := renderFixture(t, stockWithHistory())
	lines := strings.Split(r.Text, "\n")
	if len(lines) < 3 || lines[2] != "GLC — Glencore (Materials)" {
		t.Fatalf("the company line must follow the subject, got %q", lines[:min(3, len(lines))])
	}
}
