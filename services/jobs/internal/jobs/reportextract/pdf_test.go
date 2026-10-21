package reportextract

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/pdfchild"
)

// balloonSink keeps the balloon mode's allocations reachable.
var balloonSink [][]byte

// TestMain makes the test binary its own PDF child, the way main makes shorted.
func TestMain(m *testing.M) {
	if handled, code := pdfchild.Serve(map[string]pdfchild.Extract{
		PDFTextMode: ExtractPDFText,
		// balloon is a reader that never stops allocating: what one malformed
		// stream does to ledongthuc/pdf.
		"balloon": func([]byte, int) (string, error) {
			for {
				balloonSink = append(balloonSink, bytes.Repeat([]byte{1}, 16<<20))
			}
		},
	}); handled {
		os.Exit(code)
	}
	os.Exit(m.Run())
}

// onePagePDF is a valid single-page PDF that draws text with Helvetica.
func onePagePDF(text string) []byte {
	content := fmt.Sprintf("BT /F1 12 Tf 72 720 Td (%s) Tj ET", text)
	objs := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(content), content),
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	}
	var b bytes.Buffer
	b.WriteString("%PDF-1.4\n")
	offsets := make([]int, len(objs))
	for i, o := range objs {
		offsets[i] = b.Len()
		fmt.Fprintf(&b, "%d 0 obj\n%s\nendobj\n", i+1, o)
	}
	xref := b.Len()
	fmt.Fprintf(&b, "xref\n0 %d\n0000000000 65535 f \n", len(objs)+1)
	for _, off := range offsets {
		fmt.Fprintf(&b, "%010d 00000 n \n", off)
	}
	fmt.Fprintf(&b, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objs)+1, xref)
	return b.Bytes()
}

func TestDownloadPDFTextReadsInAChild(t *testing.T) {
	sentence := strings.Repeat("Dividend of 42 cents per share fully franked. ", 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(onePagePDF(sentence))
	}))
	defer srv.Close()
	got := newFetcher().downloadPDFText(context.Background(), srv.URL, 3)
	if !strings.Contains(got, "42 cents per share") {
		t.Fatalf("text = %q, want the page's sentence", got)
	}
}

// A document the reader cannot bound costs only itself: the child is killed,
// the document reads as no text, and the next one reads normally.
func TestDownloadPDFTextSurvivesAReaderThatBalloons(t *testing.T) {
	if _, err := os.Stat("/proc/self/status"); err != nil {
		t.Skip("no /proc: the deadline is the bound here, and it is a minute")
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(onePagePDF(strings.Repeat("x", 200)))
	}))
	defer srv.Close()
	f := newFetcher()
	f.pdfs = pdfchild.NewReader("balloon", 0)
	if got := f.downloadPDFText(context.Background(), srv.URL, 3); got != "" {
		t.Fatalf("a killed child must yield no text, got %q", got)
	}
	f.pdfs = pdfchild.NewReader(PDFTextMode, 0)
	if got := f.downloadPDFText(context.Background(), srv.URL, 3); !strings.Contains(got, "xxxx") {
		t.Fatalf("the next document must still read, got %q", got)
	}
}
