package reportextract

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/cookiejar"
	"regexp"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/pdfchild"
	"github.com/ledongthuc/pdf"
)

// PDFTextMode is the pdfchild mode that runs ExtractPDFText; main serves it.
const PDFTextMode = "text"

// defaultPDFMemory is the resident memory a fetcher's PDF children share
// unless WithPDFMemory says otherwise: two notices at once at the smallest
// allowance, inside a 1 GiB job with room for the parent.
const defaultPDFMemory = 512 << 20

// asxHeaders is extract.py's ASX_HEADERS, applied to every ASX request. ASX
// serves announcement PDFs only to browser-shaped clients; the UA string and
// Referer are load-bearing, not decoration.
var asxHeaders = map[string]string{
	"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	"Accept":     "application/pdf,*/*",
	"Referer":    "https://www.asx.com.au/",
}

// Timeouts are per-request, matching requests' `timeout=` at each call site.
const (
	resolveTimeout  = 15 * time.Second
	downloadTimeout = 60 * time.Second
)

// minPDFTextChars is extract.py's floor: below this the PDF is an image scan or
// a cover page and is treated as "no text".
const minPDFTextChars = 100

// maxPDFBytes bounds a single announcement download. requests streamed the whole
// body unbounded; a shared batch binary must not be OOM-able by one hostile URL.
// ASX announcement PDFs are single-digit MB; 64 MiB is far above any real filing.
const maxPDFBytes = pdfchild.MaxPDFBytes

// pdfURLPattern extracts the real announcements.asx.com.au URL from the hidden
// form field on ASX's displayAnnouncement.do terms page.
var pdfURLPattern = regexp.MustCompile(`name="pdfURL"\s+value="([^"]+)"`)

// pdfMagic is the file signature both Python checks (`content[:5] == b"%PDF-"`)
// guard on.
var pdfMagic = []byte("%PDF-")

// pdfFetcher is the PDF-text source. An interface so the report and director
// pipelines are unit-testable without a network or a real PDF.
type pdfFetcher interface {
	downloadPDFText(ctx context.Context, url string, maxPages int) string
}

// fetcher is the shared HTTP client for ASX downloads.
//
// Python created one requests.Session per THREAD (thread-local) purely because
// requests.Session is not thread-safe. http.Client is, so one client is shared
// across all workers — the connection pooling the Session provided is kept, the
// per-thread duplication is not.
type fetcher struct {
	client *http.Client
	// pdfs reads every document in a child process (package pdfchild), so a
	// PDF the reader cannot bound costs only itself.
	pdfs *pdfchild.Reader
}

func newFetcher() *fetcher {
	return newFetcherWithPDFMemory(defaultPDFMemory)
}

func newFetcherWithPDFMemory(pdfMemory int64) *fetcher {
	// Cookie jar restores requests.Session parity: the displayAnnouncement.do
	// terms page may set cookies the announcements.asx.com.au PDF host checks
	// on the follow-up GET — without a jar every display-URL resolve could
	// systematically degrade to no_pdf, masked by the tally.
	jar, _ := cookiejar.New(nil)
	return &fetcher{client: &http.Client{Jar: jar}, pdfs: pdfchild.NewReader(PDFTextMode, pdfMemory)}
}

// AnnouncementTextFetcher downloads an ASX announcement's text the way the
// report and director jobs do: displayAnnouncement.do resolution, ASX headers
// and the same PDF extraction. Safe for concurrent use.
type AnnouncementTextFetcher struct{ f *fetcher }

// FetcherOption configures an AnnouncementTextFetcher.
type FetcherOption func(*fetcherOptions)

type fetcherOptions struct{ pdfMemory int64 }

// WithPDFMemory sets the resident memory the fetcher's PDF reader children
// share (pdfchild.Reader); a child waits until its allowance fits.
func WithPDFMemory(bytes int64) FetcherOption {
	return func(o *fetcherOptions) { o.pdfMemory = bytes }
}

// NewAnnouncementTextFetcher returns a fetcher with its own HTTP client.
func NewAnnouncementTextFetcher(opts ...FetcherOption) *AnnouncementTextFetcher {
	o := fetcherOptions{pdfMemory: defaultPDFMemory}
	for _, opt := range opts {
		opt(&o)
	}
	return &AnnouncementTextFetcher{f: newFetcherWithPDFMemory(o.pdfMemory)}
}

// Text returns the text of the announcement's first maxPages pages, or "" on
// any failure (unresolvable page, non-PDF body, unparseable PDF, too little text).
func (a *AnnouncementTextFetcher) Text(ctx context.Context, url string, maxPages int) string {
	return a.f.downloadPDFText(ctx, url, maxPages)
}

// PDF returns the announcement's PDF bytes: displayAnnouncement.do
// resolution, ASX headers, the size bound and the %PDF- check, with no text
// extraction. For a caller that reads the document its own way.
func (a *AnnouncementTextFetcher) PDF(ctx context.Context, url string) ([]byte, error) {
	return a.f.downloadPDF(ctx, url)
}

// downloadPDF is downloadPDFText's fetch half.
func (f *fetcher) downloadPDF(ctx context.Context, url string) ([]byte, error) {
	pdfURL := url
	if strings.Contains(url, "displayAnnouncement.do") {
		pdfURL = f.resolveASXPDFURL(ctx, url)
		if pdfURL == "" {
			return nil, fmt.Errorf("could not resolve PDF URL")
		}
	}
	resp, err := f.get(ctx, pdfURL, downloadTimeout)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxPDFBytes))
	if err != nil {
		return nil, err
	}
	if !bytes.HasPrefix(body, pdfMagic) {
		return nil, fmt.Errorf("not a PDF response")
	}
	return body, nil
}

// get issues a GET with the ASX browser headers and a per-request deadline.
func (f *fetcher) get(ctx context.Context, url string, timeout time.Duration) (*http.Response, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		cancel()
		return nil, err
	}
	for k, v := range asxHeaders {
		req.Header.Set(k, v)
	}
	resp, err := f.client.Do(req)
	if err != nil {
		cancel()
		return nil, err
	}
	// The response body owns the deadline until it is closed.
	resp.Body = &cancelOnClose{ReadCloser: resp.Body, cancel: cancel}
	return resp, nil
}

// cancelOnClose releases a per-request context when the body is closed.
type cancelOnClose struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (c *cancelOnClose) Close() error {
	err := c.ReadCloser.Close()
	c.cancel()
	return err
}

// resolveASXPDFURL resolves an ASX displayAnnouncement.do URL to the real PDF
// URL at announcements.asx.com.au (extract.py's resolve_asx_pdf_url).
//
// Returns "" (not an error) whenever the page can't be resolved — the caller
// treats that exactly as Python's None: log and skip the report.
func (f *fetcher) resolveASXPDFURL(ctx context.Context, displayURL string) string {
	resp, err := f.get(ctx, displayURL, resolveTimeout)
	if err != nil {
		log.Printf("  Failed to resolve PDF URL: %v", err)
		return ""
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return ""
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxPDFBytes))
	if err != nil {
		log.Printf("  Failed to resolve PDF URL: %v", err)
		return ""
	}
	// Already a direct PDF.
	if bytes.HasPrefix(body, pdfMagic) {
		return displayURL
	}
	if m := pdfURLPattern.FindSubmatch(body); m != nil {
		return string(m[1])
	}
	return ""
}

// downloadPDFText downloads an ASX announcement PDF and extracts up to maxPages
// pages of text (extract.py's download_pdf_text).
//
// The body streams from the response into a pdfchild reader: the parent never
// holds the document, and a PDF the reader cannot bound is killed with its
// child instead of taking the job's memory with it.
//
// Returns "" for every failure mode Python returned None for: unresolvable
// display URL, non-200, non-PDF body, unparseable PDF, or <100 chars of text.
// A child killed for its memory or its deadline is one more unparseable PDF.
func (f *fetcher) downloadPDFText(ctx context.Context, url string, maxPages int) string {
	pdfURL := url
	if strings.Contains(url, "displayAnnouncement.do") {
		resolved := f.resolveASXPDFURL(ctx, url)
		if resolved == "" {
			log.Printf("  Could not resolve PDF URL")
			return ""
		}
		pdfURL = resolved
	}

	resp, err := f.get(ctx, pdfURL, downloadTimeout)
	if err != nil {
		log.Printf("  PDF download/extract failed: %v", err)
		return ""
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		log.Printf("  HTTP %d for %s", resp.StatusCode, pdfURL)
		return ""
	}
	body := bufio.NewReader(resp.Body)
	if head, err := body.Peek(len(pdfMagic)); err != nil || !bytes.Equal(head, pdfMagic) {
		log.Printf("  Not a PDF response")
		return ""
	}

	text, err := f.pdfs.Read(ctx, body, resp.ContentLength, maxPages)
	if err != nil {
		log.Printf("  PDF download/extract failed: %v", err)
		return ""
	}
	if runeLen(strings.TrimSpace(text)) < minPDFTextChars {
		log.Printf("  Very little text extracted (%d chars)", runeLen(text))
		return ""
	}
	return text
}

// ExtractPDFText renders the first maxPages pages of a PDF to plain text,
// joining pages with a blank line — the shape extract.py produced with
// `"\n\n".join(page.get_text() for page in doc[:max_pages])`.
//
// ENGINE DIVERGENCE: Python used pymupdf (MuPDF). There is no pure-Go MuPDF, and
// a cgo binding cannot ship in the distroless/static image, so this uses
// github.com/ledongthuc/pdf. Layout, whitespace and glyph coverage therefore
// DIFFER from pymupdf's output — see the README's Phase 3 port notes. Page
// selection, the join separator and the <100-char floor are unchanged.
//
// It runs in a pdfchild child (PDFTextMode), never in a job's own process.
func ExtractPDFText(data []byte, maxPages int) (text string, err error) {
	// The reader panics on malformed xref tables/objects rather than returning
	// an error; a corrupt announcement must not take the whole batch down.
	defer func() {
		if r := recover(); r != nil {
			text, err = "", fmt.Errorf("pdf parse panic: %v", r)
		}
	}()

	reader, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", fmt.Errorf("open pdf: %w", err)
	}

	numPages := reader.NumPage()
	if maxPages > 0 && numPages > maxPages {
		numPages = maxPages
	}

	pages := make([]string, 0, numPages)
	// Fonts are cached across pages (charmap parsing dominates the cost).
	fonts := map[string]*pdf.Font{}
	for i := 1; i <= numPages; i++ {
		p := reader.Page(i)
		if p.V.IsNull() {
			pages = append(pages, "")
			continue
		}
		for _, name := range p.Fonts() {
			if _, ok := fonts[name]; !ok {
				fnt := p.Font(name)
				fonts[name] = &fnt
			}
		}
		pageText, perr := p.GetPlainText(fonts)
		if perr != nil {
			// pymupdf skipped nothing on a bad page; a per-page failure here
			// yields an empty page rather than losing the whole document.
			pageText = ""
		}
		pages = append(pages, pageText)
	}
	return strings.Join(pages, "\n\n"), nil
}
