package announcements

import (
	"strings"
	"testing"
)

// page wraps rows in the structure the ASX announcements page uses.
func page(rows string) string {
	return `<html><body><announcement_data><table><tbody>` + rows + `</tbody></table></announcement_data></body></html>`
}

const link = `<a href="/asxpdf/20260803/pdf/abc.pdf">Half Year Results<span class="page">12 pages</span></a>`

// The price-sensitivity marker is the highest-value field on an announcement:
// it is a judgement the EXCHANGE made, which is far stronger than any
// classifier run over a headline afterwards.
//
// It was never set. The condition required the cell to carry non-empty TEXT in
// addition to the `pricesens` class, so a marker drawn as an icon — an <img>
// with no text node, the ordinary way such a flag is rendered — read as false.
// All 49,615 announcements held locally have is_price_sensitive = false, which
// is what that looks like from the outside.
func TestPriceSensitiveMarkerIsTheClassNotItsText(t *testing.T) {
	tests := []struct {
		name string
		cell string
		want bool
	}{
		{
			// The case that was broken: the marker is an image, no text.
			name: "icon marker with no text",
			cell: `<td class="pricesens"><img src="/images/pricesens.gif" alt="price sensitive"></td>`,
			want: true,
		},
		{
			name: "marker with text",
			cell: `<td class="pricesens">$</td>`,
			want: true,
		},
		{
			name: "marker with only whitespace",
			cell: `<td class="pricesens">   </td>`,
			want: true,
		},
		{
			name: "empty marker cell carrying the class",
			cell: `<td class="pricesens"></td>`,
			want: true,
		},
		{
			// No class means not price sensitive, whatever the cell contains.
			name: "no class",
			cell: `<td></td>`,
			want: false,
		},
		{
			name: "no class but has content",
			cell: `<td><img src="/images/spacer.gif"></td>`,
			want: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseAnnouncementRows(strings.NewReader(page(
				`<tr><td>03/08/2026</td>` + tc.cell + `<td>` + link + `</td></tr>`)))
			if err != nil {
				t.Fatalf("parse failed: %v", err)
			}
			if len(got) != 1 {
				t.Fatalf("parsed %d announcements, want 1", len(got))
			}
			if got[0].IsPriceSens != tc.want {
				t.Errorf("IsPriceSens = %v, want %v", got[0].IsPriceSens, tc.want)
			}
		})
	}
}

func TestParseAnnouncementRows(t *testing.T) {
	t.Run("extracts the fields we store", func(t *testing.T) {
		got, err := parseAnnouncementRows(strings.NewReader(page(
			`<tr><td>03/08/2026</td><td class="pricesens"><img src="x.gif"></td><td>` + link + `</td></tr>`)))
		if err != nil {
			t.Fatalf("parse failed: %v", err)
		}
		if len(got) != 1 {
			t.Fatalf("parsed %d announcements, want 1", len(got))
		}
		a := got[0]
		if a.Date != "2026-08-03" {
			t.Errorf("Date = %q, want 2026-08-03 (ASX prints dd/mm/yyyy)", a.Date)
		}
		if a.Headline != "Half Year Results" {
			t.Errorf("Headline = %q, want the link text without the page-count span", a.Headline)
		}
		if a.PDFURL != "https://www.asx.com.au/asxpdf/20260803/pdf/abc.pdf" {
			t.Errorf("PDFURL = %q, want the relative href made absolute", a.PDFURL)
		}
	})

	t.Run("skips rows with no PDF link", func(t *testing.T) {
		got, err := parseAnnouncementRows(strings.NewReader(page(
			`<tr><td>03/08/2026</td><td></td><td>No link here</td></tr>`)))
		if err != nil {
			t.Fatalf("parse failed: %v", err)
		}
		if len(got) != 0 {
			t.Errorf("parsed %d announcements from a row with no link, want 0", len(got))
		}
	})

	t.Run("skips malformed rows without failing the page", func(t *testing.T) {
		got, err := parseAnnouncementRows(strings.NewReader(page(
			`<tr><td>only one cell</td></tr>` +
				`<tr><td>03/08/2026</td><td class="pricesens"></td><td>` + link + `</td></tr>`)))
		if err != nil {
			t.Fatalf("parse failed: %v", err)
		}
		if len(got) != 1 {
			t.Fatalf("parsed %d announcements, want the one good row", len(got))
		}
	})

	// ASX prints the time on a second line of the date cell and we drop it,
	// because announcement_date is a DATE column. This test pins that as a
	// KNOWN limitation rather than letting it look intentional: an event study
	// needs to know whether news landed pre-open, intraday or post-close, and
	// recovering that needs a column and a re-crawl (issue #543).
	t.Run("the intraday time is discarded, which is a known gap", func(t *testing.T) {
		got, err := parseAnnouncementRows(strings.NewReader(page(
			`<tr><td>03/08/2026` + "\n" + `10:31 AM</td><td></td><td>` + link + `</td></tr>`)))
		if err != nil {
			t.Fatalf("parse failed: %v", err)
		}
		if len(got) != 1 {
			t.Fatalf("parsed %d announcements, want 1", len(got))
		}
		if got[0].Date != "2026-08-03" {
			t.Errorf("Date = %q, want the date portion only", got[0].Date)
		}
	})
}
