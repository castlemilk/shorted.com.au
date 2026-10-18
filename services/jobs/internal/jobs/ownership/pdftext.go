package ownership

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/ledongthuc/pdf"
	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"golang.org/x/sync/semaphore"
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
		if derr := api.Decrypt(bytes.NewReader(data), &out, model.NewDefaultConfiguration()); derr == nil {
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
// in its own process: it re-executes itself as `ownership -mode pdf-layout`,
// with the PDF on stdin and a deadline, and kills the child when its resident
// memory passes the notice's allowance. A child that dies is a notice with no
// text, never a dead run.
//
// The allowance scales with the file: pdfcpu decrypts a whole document to
// read three pages, about 32x its size resident (a 33 MB Morgan Stanley 603
// with 590 pages of annexures peaks at 1.06 GB; a 300 KB notice at 84 MB).
// Children draw their allowances from one budget, so small notices run in
// parallel and a large one waits for room. The bound is on resident memory,
// watched from outside, because the binary reserves far more address space
// than it uses: childAddressLimit is only the backstop for a platform
// without /proc.
const (
	childBaseAllowance = 64 << 20
	childPerByte       = 40
	childMinAllowance  = 256 << 20
	childMaxAllowance  = 1536 << 20
	childAddressLimit  = 4 << 30
	childTimeout       = 60 * time.Second
	childMaxOutput     = 4 << 20
	maxPDFBytes        = 64 << 20
)

// childAllowance is the resident memory a child may use for a PDF of n bytes.
func childAllowance(n int) int64 {
	a := int64(childBaseAllowance) + int64(n)*childPerByte
	return min(max(a, childMinAllowance), childMaxAllowance)
}

// textExtractor turns a downloaded PDF into layout text. An interface so the
// pass is testable without a child process.
type textExtractor interface {
	extract(ctx context.Context, pdf []byte) (string, error)
}

// childExtractor runs layoutText in a child process of this binary.
type childExtractor struct {
	exe    string
	budget *semaphore.Weighted
	total  int64
}

// newChildExtractor shares budgetBytes of resident memory among its children.
func newChildExtractor(budgetBytes int64) (*childExtractor, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("locate own executable: %w", err)
	}
	budgetBytes = max(budgetBytes, childMinAllowance)
	return &childExtractor{exe: exe, budget: semaphore.NewWeighted(budgetBytes), total: budgetBytes}, nil
}

func (c *childExtractor) extract(ctx context.Context, data []byte) (string, error) {
	allowance := min(childAllowance(len(data)), c.total)
	if err := c.budget.Acquire(ctx, allowance); err != nil {
		return "", err
	}
	defer c.budget.Release(allowance)
	ctx, cancel := context.WithTimeout(ctx, childTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, c.exe, "ownership", "-mode", modePDFLayout, "-max-pages", strconv.Itoa(noticeMaxPages))
	cmd.Stdin = bytes.NewReader(data)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &limitedBuffer{buf: &stdout, max: childMaxOutput}
	cmd.Stderr = &limitedBuffer{buf: &stderr, max: 8 << 10}
	// The child inherits nothing it could write with.
	cmd.Env = []string{"PDF_LAYOUT_CHILD=1"}
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("start pdf-layout child: %w", err)
	}
	done := make(chan struct{})
	overLimit := make(chan int64, 1)
	go watchRSS(cmd.Process, allowance, done, overLimit)
	err := cmd.Wait()
	close(done)
	select {
	case rss := <-overLimit:
		return "", fmt.Errorf("pdf-layout child killed at %d MB resident", rss>>20)
	default:
	}
	if err != nil {
		tail := strings.TrimSpace(stderr.String())
		if i := strings.LastIndex(tail, "\n"); i >= 0 && len(tail)-i < 300 {
			tail = tail[i+1:]
		}
		if len(tail) > 300 {
			tail = tail[:300]
		}
		return "", fmt.Errorf("pdf-layout child: %w (%s)", err, tail)
	}
	return stdout.String(), nil
}

// watchRSS kills the child when /proc says its resident set passed limit.
// Without /proc (macOS) it returns at once and the deadline is the bound.
func watchRSS(p *os.Process, limit int64, done <-chan struct{}, overLimit chan<- int64) {
	path := "/proc/" + strconv.Itoa(p.Pid) + "/status"
	tick := time.NewTicker(25 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-done:
			return
		case <-tick.C:
		}
		rss, ok := residentBytes(path)
		if !ok {
			return
		}
		if rss > limit {
			overLimit <- rss
			_ = p.Kill()
			return
		}
	}
}

// residentBytes reads VmRSS from a /proc/<pid>/status file.
func residentBytes(path string) (int64, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	for _, line := range strings.Split(string(b), "\n") {
		if rest, ok := strings.CutPrefix(line, "VmRSS:"); ok {
			f := strings.Fields(rest)
			if len(f) == 0 {
				return 0, false
			}
			kb, err := strconv.ParseInt(f[0], 10, 64)
			if err != nil {
				return 0, false
			}
			return kb << 10, true
		}
	}
	return 0, false
}

// limitedBuffer stops collecting past max bytes but never fails the write, so
// a chatty child cannot grow the parent.
type limitedBuffer struct {
	buf *bytes.Buffer
	max int
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	if room := l.max - l.buf.Len(); room > 0 {
		if len(p) > room {
			l.buf.Write(p[:room])
		} else {
			l.buf.Write(p)
		}
	}
	return len(p), nil
}

// runPDFLayoutChild is the child side: PDF on stdin, layout text on stdout.
func runPDFLayoutChild(stdin io.Reader, stdout io.Writer, maxPages int) error {
	// The backstop for a parent that cannot watch /proc. macOS refuses
	// RLIMIT_AS; there the deadline is the bound.
	if err := syscall.Setrlimit(syscall.RLIMIT_AS, &syscall.Rlimit{Cur: childAddressLimit, Max: childAddressLimit}); err != nil {
		fmt.Fprintf(os.Stderr, "pdf-layout: address-space limit not set: %v\n", err)
	}
	data, err := io.ReadAll(io.LimitReader(stdin, maxPDFBytes))
	if err != nil {
		return err
	}
	text, err := layoutText(data, maxPages)
	if err != nil {
		return err
	}
	_, err = io.WriteString(stdout, text)
	return err
}
