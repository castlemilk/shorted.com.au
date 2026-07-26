package reportextract

import (
	"context"
	"crypto/sha1" //nolint:gosec // the object path is a content address, not a security primitive; the stored raw_text_gcs_url pins sha1.
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"strings"

	"cloud.google.com/go/storage"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
)

// defaultReportsBucket is extract.py's GCS_REPORTS_BUCKET default. The deployed
// job sets the env var explicitly.
const defaultReportsBucket = "shorted-financial-reports"

// rawTextContentType matches the Python upload's content_type exactly (it is
// stored on the object).
const rawTextContentType = "text/plain; charset=utf-8"

// blobStore is the raw-text side channel. An interface so the pipeline is
// testable without GCS.
type blobStore interface {
	UploadRawText(ctx context.Context, stockCode, reportURL, text string) string
	DownloadText(ctx context.Context, gcsURI string) string
}

// gcsStore is the live implementation. The client is created once per run.
type gcsStore struct {
	client *storage.Client
	bucket string
}

func newGCSStore(ctx context.Context) (*gcsStore, error) {
	client, err := storage.NewClient(ctx)
	if err != nil {
		return nil, fmt.Errorf("create gcs client: %w", err)
	}
	return &gcsStore{client: client, bucket: platform.GetEnv("GCS_REPORTS_BUCKET", defaultReportsBucket)}, nil
}

func (g *gcsStore) Close() {
	if g.client != nil {
		_ = g.client.Close()
	}
}

// rawTextObjectPath is the object layout extract.py wrote and the digest
// backfill reads back: digests/<stock_code>/<sha1-of-report_url>.txt.
func rawTextObjectPath(stockCode, reportURL string) string {
	sum := sha1.Sum([]byte(reportURL)) //nolint:gosec // see import comment
	return fmt.Sprintf("digests/%s/%s.txt", stockCode, hex.EncodeToString(sum[:]))
}

// UploadRawText stores the extracted page text and returns its gs:// URI.
// Best-effort: a failure logs and returns "" (Python's None) — the extraction row
// is still written, just without a text pointer.
func (g *gcsStore) UploadRawText(ctx context.Context, stockCode, reportURL, text string) string {
	blobPath := rawTextObjectPath(stockCode, reportURL)
	gcsURI := "gs://" + g.bucket + "/" + blobPath

	w := g.client.Bucket(g.bucket).Object(blobPath).NewWriter(ctx)
	w.ContentType = rawTextContentType
	if _, err := io.WriteString(w, text); err != nil {
		_ = w.Close()
		log.Printf("  GCS upload failed (non-fatal): %v", err)
		return ""
	}
	if err := w.Close(); err != nil {
		log.Printf("  GCS upload failed (non-fatal): %v", err)
		return ""
	}
	log.Printf("  Uploaded raw text to %s", gcsURI)
	return gcsURI
}

// DownloadText fetches previously-stored page text from a gs:// URI. Used by the
// digest backfill so it can re-summarise existing rows WITHOUT re-downloading the
// PDF — important because older (2024) ASX announcement URLs no longer resolve.
// Returns "" on any failure or for blank content.
func (g *gcsStore) DownloadText(ctx context.Context, gcsURI string) string {
	bucket, object, ok := parseGCSURI(gcsURI)
	if !ok {
		return ""
	}
	r, err := g.client.Bucket(bucket).Object(object).NewReader(ctx)
	if err != nil {
		log.Printf("  GCS text fetch failed for %s: %v", gcsURI, err)
		return ""
	}
	defer func() { _ = r.Close() }()

	data, err := io.ReadAll(r)
	if err != nil {
		log.Printf("  GCS text fetch failed for %s: %v", gcsURI, err)
		return ""
	}
	text := string(data)
	if strings.TrimSpace(text) == "" {
		return ""
	}
	return text
}

// parseGCSURI splits gs://bucket/object. Mirrors download_text_from_gcs's guards:
// a non-gs:// URI, a missing bucket or a missing object path are all "not found",
// not errors.
func parseGCSURI(uri string) (bucket, object string, ok bool) {
	if uri == "" || !strings.HasPrefix(uri, "gs://") {
		return "", "", false
	}
	bucket, object, found := strings.Cut(strings.TrimPrefix(uri, "gs://"), "/")
	if !found || bucket == "" || object == "" {
		return "", "", false
	}
	return bucket, object, true
}

// noopBlobStore is used for dry runs: nothing is uploaded, nothing is read.
//
// DELIBERATE DIVERGENCE: extract.py called upload_raw_text_to_gcs BEFORE the
// dry-run check in store_extraction, so `--dry-run` still wrote objects to the
// bucket. The consolidated binary's rule is that -dry-run writes NOTHING, so the
// upload is gated too. (The digest backfill's READ path is unaffected — the
// backfill uses the live store even in a dry run so the pipeline is exercised.)
type noopBlobStore struct{ inner blobStore }

func (n noopBlobStore) UploadRawText(_ context.Context, stockCode, reportURL, _ string) string {
	log.Printf("  [dry-run] would upload raw text to gs://<bucket>/%s", rawTextObjectPath(stockCode, reportURL))
	return ""
}

func (n noopBlobStore) DownloadText(ctx context.Context, gcsURI string) string {
	if n.inner == nil {
		return ""
	}
	return n.inner.DownloadText(ctx, gcsURI)
}
