package review

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// render is the report as markdown.
func render(rep report) string {
	var b strings.Builder
	w := &b
	p := func(format string, args ...any) { fmt.Fprintf(w, format, args...) }
	p("# Shorted data review\n\n")
	p("Generated %s UTC from one read-only transaction. Window: the last %d days. Each list shows at most %d rows; the counts are complete.\n\n",
		timestamp(rep.Generated), rep.Days, rep.Limit)

	p("## Financial reports\n\n")

	p("### Newest results document not read (%d companies)\n\n", len(rep.Unread))
	p("Filed more than %d days ago and still without metrics or a digest, largest companies first.\n\n", unreadGraceDays)
	list(w, rep.Limit, []string{"Code", "Company", "Market cap", "Filed", "Document", "State"}, len(rep.Unread), func(i int) []string {
		g := rep.Unread[i]
		return []string{g.StockCode, g.CompanyName, marketCap(g.MarketCap, g.MarketCapOK), day(g.Doc.Date), link(g.Doc.Title, g.Doc.URL), g.State}
	})

	if rep.AttemptsKnown {
		due, waiting, gaveUp := 0, 0, 0
		for _, e := range rep.Empty {
			switch {
			case e.State == "retry due":
				due++
			case strings.HasPrefix(e.State, "next retry"):
				waiting++
			case strings.HasPrefix(e.State, "gave up"):
				gaveUp++
			}
		}
		p("### Empty extractions (%d: %d retry due, %d waiting, %d gave up)\n\n", len(rep.Empty), due, waiting, gaveUp)
	} else {
		p("### Empty extractions (%d)\n\n", len(rep.Empty))
	}
	p("No metrics and no usable digest (none, or confidence under %.1f) from a document with text. The extractor reads each again, at up to %d pages, at most %d times, %d days apart.\n\n",
		picksMinDigestConfidence, emptyRetryMaxPages, emptyRetryLimit, emptyRetryMinDays)
	list(w, rep.Limit, []string{"Code", "Filed", "Document", "Chars", "Attempts", "Last read", "State"}, len(rep.Empty), func(i int) []string {
		e := rep.Empty[i]
		return []string{e.StockCode, filed(e.ReportDate), link(e.Title, e.URL), chars(e.RawTextLength), strconv.Itoa(e.Attempts), timestamp(e.ExtractedAt), e.State}
	})

	p("### Unreadable documents (%d)\n\n", len(rep.Unreadable))
	p("No text layer (a scanned PDF): never retried.\n\n")
	list(w, rep.Limit, []string{"Code", "Filed", "Document", "Chars", "Read"}, len(rep.Unreadable), func(i int) []string {
		u := rep.Unreadable[i]
		return []string{u.StockCode, filed(u.ReportDate), link(u.Title, u.URL), chars(u.RawTextLength), timestamp(u.ExtractedAt)}
	})

	p("### Rows the API withholds or trims (%d)\n\n", len(rep.Withheld))
	p("The extraction exists, but a gate keeps some or all of it from readers.\n\n")
	list(w, rep.Limit, []string{"Code", "Filed", "Document", "Reasons"}, len(rep.Withheld), func(i int) []string {
		r := rep.Withheld[i]
		return []string{r.StockCode, filed(r.ReportDate), link(r.Title, r.URL), strings.Join(r.Reasons, "; ")}
	})

	p("## Dividend notices\n\n")

	p("### Outcomes\n\n")
	list(w, len(rep.Outcomes), []string{"Outcome", "Parser", "All time", fmt.Sprintf("Last %d days", rep.Days)}, len(rep.Outcomes), func(i int) []string {
		o := rep.Outcomes[i]
		return []string{o.Outcome, strconv.Itoa(o.ParserVersion), strconv.Itoa(o.Total), strconv.Itoa(o.Recent)}
	})

	p("### Failures in the window (%d)\n\n", len(rep.Failures))
	p("Every outcome but parsed and cancellation, newest first.\n\n")
	list(w, rep.Limit, []string{"Code", "Outcome", "Detail", "Notice", "Tried", "Parser"}, len(rep.Failures), func(i int) []string {
		f := rep.Failures[i]
		return []string{f.StockCode, f.Outcome, truncateRunes(f.Detail, 100), link("notice", f.URL), timestamp(f.AttemptedAt), strconv.Itoa(f.ParserVersion)}
	})
	return b.String()
}

// list writes the first limit of n rows as a table, then how many were cut;
// "None." when there are none.
func list(w *strings.Builder, limit int, header []string, n int, row func(int) []string) {
	if n == 0 {
		fmt.Fprint(w, "None.\n\n")
		return
	}
	rows := make([][]string, 0, min(n, limit))
	for i := 0; i < n && i < limit; i++ {
		rows = append(rows, row(i))
	}
	table(w, header, rows)
	if n > limit {
		fmt.Fprintf(w, "\n_… %d more not shown (raise -limit)._\n", n-limit)
	}
	fmt.Fprint(w, "\n")
}

// table writes a markdown table.
func table(w *strings.Builder, header []string, rows [][]string) {
	line := func(cells []string) {
		out := make([]string, len(cells))
		for i, c := range cells {
			out[i] = cell(c)
		}
		fmt.Fprintf(w, "| %s |\n", strings.Join(out, " | "))
	}
	line(header)
	fmt.Fprintf(w, "|%s\n", strings.Repeat(" --- |", len(header)))
	for _, r := range rows {
		line(r)
	}
}

// cell makes s safe inside a table cell: one line, no column breaks.
func cell(s string) string {
	s = strings.NewReplacer("|", `\|`, "\r\n", " ", "\n", " ", "\r", " ").Replace(s)
	return strings.TrimSpace(s)
}

// link is a markdown link to a document, its title cut to 60 runes.
func link(title, url string) string {
	title = strings.TrimSpace(title)
	if title == "" {
		title = "untitled"
	}
	title = strings.NewReplacer("[", "(", "]", ")").Replace(truncateRunes(title, 60))
	return fmt.Sprintf("[%s](%s)", title, url)
}

// truncateRunes cuts s to at most n runes, marking the cut with an ellipsis.
func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

func marketCap(v float64, ok bool) string {
	switch {
	case !ok:
		return "—"
	case v >= 1e9:
		return fmt.Sprintf("A$%.1fbn", v/1e9)
	default:
		return fmt.Sprintf("A$%.0fm", v/1e6)
	}
}

func filed(d *time.Time) string {
	if d == nil {
		return "—"
	}
	return d.Format("2006-01-02")
}

func chars(n *int) string {
	if n == nil {
		return "—"
	}
	return strconv.Itoa(*n)
}

func timestamp(t time.Time) string { return t.UTC().Format("2006-01-02 15:04") }
