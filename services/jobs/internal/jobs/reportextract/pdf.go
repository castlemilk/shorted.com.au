package reportextract

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/ledongthuc/pdf"
)

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
const maxPDFBytes = 64 << 20

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
}

func newFetcher() *fetcher {
	return &fetcher{client: &http.Client{}}
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
// Returns "" for every failure mode Python returned None for: unresolvable
// display URL, non-200, non-PDF body, unparseable PDF, or <100 chars of text.
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
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxPDFBytes))
	if err != nil {
		log.Printf("  PDF download/extract failed: %v", err)
		return ""
	}
	if !bytes.HasPrefix(body, pdfMagic) {
		log.Printf("  Not a PDF response")
		return ""
	}

	text, err := extractPDFText(body, maxPages)
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

// extractPDFText renders the first maxPages pages of a PDF to plain text,
// joining pages with a blank line — the shape extract.py produced with
// `"\n\n".join(page.get_text() for page in doc[:max_pages])`.
//
// ENGINE DIVERGENCE: Python used pymupdf (MuPDF). There is no pure-Go MuPDF, and
// a cgo binding cannot ship in the distroless/static image, so this uses
// github.com/ledongthuc/pdf. Layout, whitespace and glyph coverage therefore
// DIFFER from pymupdf's output — see the README's Phase 3 port notes. Page
// selection, the join separator and the <100-char floor are unchanged.
func extractPDFText(data []byte, maxPages int) (text string, err error) {
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
