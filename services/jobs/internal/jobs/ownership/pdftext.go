package ownership

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/pdfchild"
	"github.com/ledongthuc/pdf"
	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
)

// A substantial holding notice is a statutory form: its figures sit in a table
// on the first page or two, and a filled-in PDF form draws its field values
// after every label. Plain text (GetPlainText) keeps the drawing order, so a
// name lands pages away from "Name" and a votes cell glues onto its voting
// power cell ("197,489,5146.12%"). layoutText rebuilds lines from glyph
// positions instead, the way `pdftotext -layout` does, with " | " between
// cells. The image is distroless, so this is pure Go.

// noticeMaxPages is how much of a notice is read: the form is one to three
// pages; what follows is annexures (a bank's 900-page list of trades).
const noticeMaxPages = 3

// pdfMagic is the file signature every PDF starts with.
var pdfMagic = []byte("%PDF-")

// layoutText renders the first maxPages pages of a PDF as lines of text.
//
// An encrypted PDF (most bank-filed notices: AES-256, empty user password) is
// decrypted with pdfcpu first; ledongthuc/pdf cannot read AES-256 and misreads
// some RC4 files into garbage.
func layoutText(data []byte, maxPages int) (text string, err error) {
	defer func() {
		if r := recover(); r != nil {
			text, err = "", fmt.Errorf("pdf parse panic: %v", r)
		}
	}()
	if !bytes.HasPrefix(data, pdfMagic) {
		return "", errors.New("not a PDF")
	}
	if bytes.Contains(data, []byte("/Encrypt")) {
		var out bytes.Buffer
		if derr := api.Decrypt(context.Background(), bytes.NewReader(data), &out, model.NewDefaultConfiguration()); derr == nil {
			data = out.Bytes()
		}
	}
	reader, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", fmt.Errorf("open pdf: %w", err)
	}
	n := reader.NumPage()
	if maxPages > 0 && n > maxPages {
		n = maxPages
	}
	var pages []string
	for i := 1; i <= n; i++ {
		p := reader.Page(i)
		if p.V.IsNull() {
			continue
		}
		pages = append(pages, layoutTexts(p.Content().Text))
	}
	return strings.Join(pages, "\n\n"), nil
}

// layoutTexts lays out one page's text items. Items arrive in drawing order,
// which is right WITHIN a run of text and wrong across a form's fields; their
// X positions are the reverse (a subset font's widths can be off by a glyph).
// So consecutive items on one baseline that continue each other form a run,
// kept in drawing order, and runs are what is placed by position: grouped
// into lines by baseline, ordered left to right, with " | " where a gap
// between runs is wider than about a character.
func layoutTexts(texts []pdf.Text) string {
	type run struct {
		x0, x1, y, fs float64
		b             strings.Builder
	}
	var runs []*run
	var cur *run
	for _, t := range texts {
		// Some writers emit a zero-width "\n" item between every glyph
		// (MGH's 2026-10-16 notice: "5", "\n", "5", "\n", ".", ...); written
		// out, it splits "55.05%" into "5 5 . 05 %". The gap between the
		// glyphs on either side decides whether there is a space.
		if strings.Trim(t.S, "\r\n") == "" {
			continue
		}
		fs := t.FontSize
		if fs <= 0 {
			fs = 8
		}
		tol := math.Max(fs*0.35, 1)
		if cur != nil && math.Abs(t.Y-cur.y) <= tol && t.X >= cur.x0-fs*0.5 && t.X <= cur.x1+fs*1.2 {
			if t.X-cur.x1 > fs*0.2 && !strings.HasPrefix(t.S, " ") {
				cur.b.WriteString(" ")
			}
			cur.b.WriteString(t.S)
			cur.x1 = math.Max(cur.x1, t.X+t.W)
			continue
		}
		cur = &run{x0: t.X, x1: t.X + t.W, y: t.Y, fs: fs}
		cur.b.WriteString(t.S)
		runs = append(runs, cur)
	}
	sort.SliceStable(runs, func(i, j int) bool { return runs[i].y > runs[j].y })
	type line struct {
		y    float64
		runs []*run
	}
	var lines []*line
	for _, r := range runs {
		if strings.TrimSpace(r.b.String()) == "" {
			continue
		}
		tol := math.Max(r.fs*0.45, 1.5)
		if n := len(lines); n > 0 && math.Abs(lines[n-1].y-r.y) <= tol {
			lines[n-1].runs = append(lines[n-1].runs, r)
			continue
		}
		lines = append(lines, &line{y: r.y, runs: []*run{r}})
	}
	var b strings.Builder
	for _, ln := range lines {
		sort.SliceStable(ln.runs, func(i, j int) bool { return ln.runs[i].x0 < ln.runs[j].x0 })
		prevEnd := math.Inf(-1)
		for _, r := range ln.runs {
			if !math.IsInf(prevEnd, -1) {
				if r.x0-prevEnd > r.fs*1.2 {
					b.WriteString(" | ")
				} else {
					b.WriteString(" ")
				}
			}
			b.WriteString(strings.TrimSpace(strings.ReplaceAll(r.b.String(), "\ufffd", " ")))
			prevEnd = math.Max(prevEnd, r.x1)
		}
		b.WriteString("\n")
	}
	return b.String()
}

// A malformed content stream sends ledongthuc/pdf's array reader into an
// unbounded loop (TLX's 2026-07-24 notice asked for a 790 MB block), and a
// recover() cannot catch an out-of-memory. So the job never parses a notice
// in its own process: it reads each one in a pdfchild child (PDFLayoutMode),
// which is killed when its resident memory passes the notice's allowance. A
// child that dies is a notice with no text, never a dead run.
//
// The allowance scales with the file: pdfcpu decrypts a whole document to
// read three pages, about 32x its size resident (a 33 MB Morgan Stanley 603
// with 590 pages of annexures peaks at 1.06 GB; a 300 KB notice at 84 MB).
// Children draw their allowances from one budget (-child-memory-mb), so small
// notices run in parallel and a large one waits for room.

// PDFLayoutMode is the pdfchild mode that runs LayoutText; main serves it.
const PDFLayoutMode = "layout"

// LayoutText is layoutText, as a pdfchild child runs it.
func LayoutText(data []byte, maxPages int) (string, error) {
	return layoutText(data, maxPages)
}

// textExtractor turns a downloaded PDF into layout text. An interface so the
// pass is testable without a child process.
type textExtractor interface {
	extract(ctx context.Context, pdf []byte) (string, error)
}

// childExtractor reads a notice's first noticeMaxPages pages in a child.
type childExtractor struct{ pdfs *pdfchild.Reader }

func (c childExtractor) extract(ctx context.Context, data []byte) (string, error) {
	return c.pdfs.Read(ctx, bytes.NewReader(data), int64(len(data)), noticeMaxPages)
}
