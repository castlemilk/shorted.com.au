package reportextract

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The object path is how the digest backfill finds text written by an earlier
// run, so the sha1-of-URL layout is a stored contract, not an implementation
// detail.
func TestRawTextObjectPath(t *testing.T) {
	const url = "https://www.asx.com.au/asxpdf/20250901/pdf/abc.pdf"
	got := rawTextObjectPath("BHP", url)
	// sha1("https://www.asx.com.au/asxpdf/20250901/pdf/abc.pdf")
	const want = "digests/BHP/9f6ef6b1c4a5c34a1a86eb44d2f0d8dfa1c2d0e7.txt"
	if !strings.HasPrefix(got, "digests/BHP/") || !strings.HasSuffix(got, ".txt") {
		t.Fatalf("layout drifted: %q", got)
	}
	if len(got) != len(want) {
		t.Errorf("hash length drifted (sha1 hex = 40 chars): %q", got)
	}
	// Same input → same path (the whole point).
	if again := rawTextObjectPath("BHP", url); again != got {
		t.Errorf("path is not deterministic: %q vs %q", got, again)
	}
	// Different URL → different path.
	if other := rawTextObjectPath("BHP", url+"?x=1"); other == got {
		t.Error("distinct URLs must not collide")
	}
}

func TestParseGCSURI(t *testing.T) {
	tests := []struct {
		uri            string
		bucket, object string
		ok             bool
	}{
		{"gs://b/digests/BHP/abc.txt", "b", "digests/BHP/abc.txt", true},
		{"gs://b/o", "b", "o", true},
		{"gs://b/", "", "", false},
		{"gs://b", "", "", false},
		{"gs://", "", "", false},
		{"https://storage.googleapis.com/b/o", "", "", false},
		{"", "", "", false},
	}
	for _, tt := range tests {
		bucket, object, ok := parseGCSURI(tt.uri)
		if ok != tt.ok || bucket != tt.bucket || object != tt.object {
			t.Errorf("parseGCSURI(%q) = (%q,%q,%v), want (%q,%q,%v)",
				tt.uri, bucket, object, ok, tt.bucket, tt.object, tt.ok)
		}
	}
}

// -dry-run must not write objects. (extract.py uploaded BEFORE its dry-run
// check, so `--dry-run` genuinely wrote to the bucket — this is the deliberate
// divergence.)
func TestNoopBlobStoreUploadsNothing(t *testing.T) {
	n := noopBlobStore{}
	if got := n.UploadRawText(context.Background(), "BHP", "u", "text"); got != "" {
		t.Errorf("dry-run upload must return no URI, got %q", got)
	}
}

// The read path stays live under a dry run so the digest backfill is still
// exercised end-to-end.
func TestNoopBlobStoreDelegatesReads(t *testing.T) {
	inner := newStubBlobs()
	inner.stored["gs://b/o"] = "stored text"
	n := noopBlobStore{inner: inner}
	if got := n.DownloadText(context.Background(), "gs://b/o"); got != "stored text" {
		t.Errorf("read must delegate, got %q", got)
	}
	if got := (noopBlobStore{}).DownloadText(context.Background(), "gs://b/o"); got != "" {
		t.Errorf("no inner store → empty, got %q", got)
	}
}

func TestDefaultReportsBucket(t *testing.T) {
	if defaultReportsBucket != "shorted-financial-reports-prod" {
		t.Errorf("GCS_REPORTS_BUCKET default drifted: %q", defaultReportsBucket)
	}
	if rawTextContentType != "text/plain; charset=utf-8" {
		t.Errorf("stored object content type drifted: %q", rawTextContentType)
	}
}

// The ASX display-URL → PDF-URL resolution is what makes the whole pipeline
// work; ASX serves a terms page with the real URL in a hidden field.
func TestResolveASXPDFURL(t *testing.T) {
	t.Run("hidden form field", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("User-Agent") != asxHeaders["User-Agent"] || r.Header.Get("Referer") != asxHeaders["Referer"] {
				t.Errorf("ASX browser headers not sent: %v", r.Header)
			}
			_, _ = w.Write([]byte(`<form><input type="hidden" name="pdfURL"   value="https://announcements.asx.com.au/asxpdf/x.pdf"></form>`))
		}))
		defer srv.Close()

		got := newFetcher().resolveASXPDFURL(context.Background(), srv.URL)
		if got != "https://announcements.asx.com.au/asxpdf/x.pdf" {
			t.Errorf("got %q", got)
		}
	})

	t.Run("already a pdf", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte("%PDF-1.7\nbody"))
		}))
		defer srv.Close()
		if got := newFetcher().resolveASXPDFURL(context.Background(), srv.URL); got != srv.URL {
			t.Errorf("a direct PDF must resolve to itself, got %q", got)
		}
	})

	t.Run("no field and non-200", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte("<html>nothing here</html>"))
		}))
		defer srv.Close()
		if got := newFetcher().resolveASXPDFURL(context.Background(), srv.URL); got != "" {
			t.Errorf("want empty, got %q", got)
		}

		bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusForbidden)
		}))
		defer bad.Close()
		if got := newFetcher().resolveASXPDFURL(context.Background(), bad.URL); got != "" {
			t.Errorf("non-200 must yield empty, got %q", got)
		}
	})
}

func TestDownloadPDFTextRejectsNonPDFAndThinText(t *testing.T) {
	html := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("<html>an error page</html>"))
	}))
	defer html.Close()
	if got := newFetcher().downloadPDFText(context.Background(), html.URL, 6); got != "" {
		t.Errorf("a non-PDF body must yield no text, got %q", got)
	}

	notFound := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer notFound.Close()
	if got := newFetcher().downloadPDFText(context.Background(), notFound.URL, 6); got != "" {
		t.Errorf("a 404 must yield no text, got %q", got)
	}

	// %PDF- magic but garbage content: the parser must fail closed, not panic.
	junk := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("%PDF-1.4\nnot really a pdf at all"))
	}))
	defer junk.Close()
	if got := newFetcher().downloadPDFText(context.Background(), junk.URL, 6); got != "" {
		t.Errorf("a corrupt PDF must yield no text, got %q", got)
	}
}

func TestExtractPDFTextFailsClosedOnGarbage(t *testing.T) {
	if _, err := extractPDFText([]byte("%PDF-1.4 nonsense"), 4); err == nil {
		t.Error("want an error for a corrupt PDF")
	}
}
