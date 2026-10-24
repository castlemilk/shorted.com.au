package alerts

import (
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
)

// The caption names the real range the history covers, from its first and last
// readings, with the year once when both ends share one.
func TestHistorySpanCaption(t *testing.T) {
	cases := []struct {
		first, last, want string
	}{
		{"2026-04-17", "2026-10-16", "17 Apr – 16 Oct 2026"},
		{"2025-11-17", "2026-10-16", "17 Nov 2025 – 16 Oct 2026"},
	}
	for _, tc := range cases {
		m := stockWithHistory()
		// Twenty-five readings, so the history is long: the first and last are the ends
		// of the range the caption names.
		h := []alertevents.Point{{D: tc.first, P: 1}}
		for i := 0; i < 23; i++ {
			h = append(h, alertevents.Point{D: "2026-06-01", P: 2})
		}
		h = append(h, alertevents.Point{D: tc.last, P: 3})
		m.Payload.Stock.History = h
		r := renderFixture(t, m)
		if want := "· " + tc.want; !strings.Contains(r.HTML, want) {
			t.Errorf("caption must read %q", want)
		}
		if strings.Contains(r.HTML, "last 6 months") {
			t.Errorf("a full history must not say last 6 months")
		}
	}
}

// A short history drops the weekday from its caption.
func TestShortHistoryCaptionHasNoWeekday(t *testing.T) {
	r := renderFixture(t, shortStock())
	if !strings.Contains(r.HTML, "since first reported 14 Oct 2026") {
		t.Fatal("the short caption must read since first reported 14 Oct 2026")
	}
	if strings.Contains(r.HTML, "since first reported Wed") {
		t.Fatal("the short caption must not carry a weekday")
	}
}

// The dark image's wrapper must not clip its border or corners, and the dark fill is
// faint enough not to read as a brown slab.
func TestDarkPanelIsNotClipped(t *testing.T) {
	r := renderFixture(t, stockWithHistory())
	if !strings.Contains(r.HTML, "overflow: visible !important;") {
		t.Fatal("the dark-mode wrapper must lift overflow:hidden so the border and radius show")
	}
	if !strings.Contains(r.HTML, `border:1px solid #352E27;border-radius:6px;`) {
		t.Fatal("the dark image needs the terminal-border panel")
	}
}
