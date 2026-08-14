package influence

// Fetching for the register crawl.
//
// Two properties this file exists to guarantee:
//
//  1. STREAMING. ckan.go's downloadResource does io.ReadAll, which materialises
//     the whole body. Senate volumes in the 2013+ window reach 33MB and the
//     out-of-window ones reach 196MB; a Cloud Run job with a modest memory limit
//     dies on that. Every byte here goes body -> temp file, hashed on the way
//     through, and is never held whole in memory.
//
//  2. A BLOCK IS A SIGNAL. APH's WAF allowlists browser User-Agent tokens (see
//     aph_register.go). If it ever starts 403ing us, that is a policy change we
//     need to know about — so a 403 is recorded as fetch_status='blocked', is
//     never retried, and aborts the run. We do not route around it.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"cloud.google.com/go/storage"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// pdfMagic guards against an interstitial or error page served with HTTP
	// 200 and an HTML body — which is exactly how a silent corpus of zero-byte
	// "PDFs" gets built.
	pdfMagic = "%PDF-"

	defaultRegisterFetchDelayMS = 1500
	defaultRegisterMaxAttempts  = 3
	// Crawled documents live on the external volume, NOT /tmp.
	//
	// /tmp is cleared on reboot, and this cache is a ~2GB corpus fetched from
	// aph.gov.au one document at a time at a deliberate 1.5s delay — losing it
	// means re-crawling a parliamentary website for 20+ minutes for no reason.
	// Overridable with REGISTER_CACHE_DIR; falls back to /tmp when the volume is
	// not mounted, so a machine without it still works.
	defaultRegisterCacheDir  = "/Volumes/gamma-systems-2/shorted-crawl/aph-register"
	fallbackRegisterCacheDir = "/tmp/aph-register"
)

// registerRetryBackoff is only ever applied to 429/5xx/transport failures.
var registerRetryBackoff = []time.Duration{5 * time.Second, 20 * time.Second, 60 * time.Second}

// DocumentSink stores fetched bytes. Content-addressed by sha256 so a
// re-extraction never re-crawls and "did APH change this document?" is a byte
// comparison rather than a guess.
type DocumentSink interface {
	Exists(ctx context.Context, sha string) (bool, error)
	Put(ctx context.Context, sha string, r io.Reader) (uri string, size int64, err error)
	Describe() string
}

// ---------------------------------------------------------------------------
// Local sink (dev + parser development)
// ---------------------------------------------------------------------------

type localSink struct{ dir string }

func newLocalSink(dir string) (DocumentSink, error) {
	if dir == "" {
		dir = defaultRegisterCacheDir
		// Only fall back when the external volume is genuinely absent — never
		// silently when it is merely slow to mount.
		if volume := filepath.Dir(filepath.Dir(defaultRegisterCacheDir)); volume != "" {
			if _, err := os.Stat(volume); err != nil {
				dir = fallbackRegisterCacheDir
			}
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("register cache dir: %w", err)
	}
	return &localSink{dir: dir}, nil
}

func (s *localSink) path(sha string) string { return filepath.Join(s.dir, sha+".pdf") }

func (s *localSink) Exists(_ context.Context, sha string) (bool, error) {
	_, err := os.Stat(s.path(sha))
	if err == nil {
		return true, nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return false, err
}

func (s *localSink) Put(_ context.Context, sha string, r io.Reader) (string, int64, error) {
	dst := s.path(sha)
	tmp, err := os.CreateTemp(s.dir, ".put-*")
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = os.Remove(tmp.Name()) }()

	n, err := io.Copy(tmp, r)
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", 0, err
	}
	if err := os.Rename(tmp.Name(), dst); err != nil {
		return "", 0, err
	}
	return "file://" + dst, n, nil
}

func (s *localSink) Describe() string { return "local:" + s.dir }

// ---------------------------------------------------------------------------
// GCS sink (Cloud Run)
// ---------------------------------------------------------------------------

type gcsSink struct {
	client *storage.Client
	bucket string
	prefix string
}

// newGCSSink writes to a PRIVATE bucket. The licence permits extracted facts,
// not a PDF mirror, so the bucket must have uniform bucket-level access,
// public_access_prevention=enforced, no allUsers IAM, and an object lifecycle —
// all enforced in terraform. storage_uri never reaches a read path.
func newGCSSink(ctx context.Context, bucket, prefix string) (DocumentSink, error) {
	client, err := storage.NewClient(ctx)
	if err != nil {
		return nil, fmt.Errorf("gcs client: %w", err)
	}
	return &gcsSink{client: client, bucket: bucket, prefix: strings.Trim(prefix, "/")}, nil
}

func (s *gcsSink) object(sha string) string {
	if s.prefix == "" {
		return sha + ".pdf"
	}
	return s.prefix + "/" + sha + ".pdf"
}

func (s *gcsSink) Exists(ctx context.Context, sha string) (bool, error) {
	_, err := s.client.Bucket(s.bucket).Object(s.object(sha)).Attrs(ctx)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, storage.ErrObjectNotExist) {
		return false, nil
	}
	return false, err
}

func (s *gcsSink) Put(ctx context.Context, sha string, r io.Reader) (string, int64, error) {
	w := s.client.Bucket(s.bucket).Object(s.object(sha)).NewWriter(ctx)
	w.ContentType = "application/pdf"
	n, err := io.Copy(w, r)
	if err != nil {
		_ = w.Close()
		return "", 0, err
	}
	if err := w.Close(); err != nil {
		return "", 0, err
	}
	return fmt.Sprintf("gs://%s/%s", s.bucket, s.object(sha)), n, nil
}

func (s *gcsSink) Describe() string { return fmt.Sprintf("gs://%s/%s", s.bucket, s.prefix) }

// newRegisterSink picks GCS when REGISTER_BUCKET is set, else a local cache.
func newRegisterSink(ctx context.Context) (DocumentSink, error) {
	if bucket := strings.TrimSpace(os.Getenv("REGISTER_BUCKET")); bucket != "" {
		prefix := strings.TrimSpace(os.Getenv("REGISTER_BUCKET_PREFIX"))
		if prefix == "" {
			prefix = "aph"
		}
		return newGCSSink(ctx, bucket, prefix)
	}
	return newLocalSink(strings.TrimSpace(os.Getenv("REGISTER_CACHE_DIR")))
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

// PendingDocument is a manifest row awaiting bytes.
type PendingDocument struct {
	ID        string
	SourceURL string
	Chamber   string
	Attempts  int
}

// FetchResult is what one successful fetch learned about a document.
type FetchResult struct {
	SHA256     string
	ByteSize   int64
	StorageURI string
	HTTPStatus int
	Deduped    bool // the sha was already in the sink
}

// errBlocked marks a 403. It is deliberately distinct from a transport error so
// the caller can record 'blocked', skip retries, and raise its own alarm.
type errBlocked struct {
	URL    string
	Status int
}

func (e *errBlocked) Error() string {
	return fmt.Sprintf("blocked fetching %s: HTTP %d (APH WAF policy change?)", e.URL, e.Status)
}

// fetchRegisterDocument streams one PDF into the sink.
//
// The body goes to a temp file while sha256 accumulates, so nothing is buffered
// whole and the hash is known before we decide whether to store.
func fetchRegisterDocument(ctx context.Context, client *http.Client, doc PendingDocument, sink DocumentSink) (FetchResult, error) {
	var res FetchResult

	req, err := newAPHRequest(ctx, doc.SourceURL)
	if err != nil {
		return res, err
	}
	req.Header.Set("Accept", "application/pdf,*/*")

	resp, err := client.Do(req)
	if err != nil {
		return res, fmt.Errorf("fetch %s: %w", doc.SourceURL, err)
	}
	defer func() { _ = resp.Body.Close() }()

	res.HTTPStatus = resp.StatusCode
	if resp.StatusCode == http.StatusForbidden {
		return res, &errBlocked{URL: doc.SourceURL, Status: resp.StatusCode}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return res, fmt.Errorf("fetch %s: HTTP %d", doc.SourceURL, resp.StatusCode)
	}

	tmp, err := os.CreateTemp("", "aph-fetch-*.pdf")
	if err != nil {
		return res, err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()

	hasher := sha256.New()
	size, copyErr := io.Copy(io.MultiWriter(tmp, hasher), resp.Body)
	if closeErr := tmp.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		return res, fmt.Errorf("stream %s: %w", doc.SourceURL, copyErr)
	}
	if size == 0 {
		return res, fmt.Errorf("fetch %s: empty body", doc.SourceURL)
	}

	if err := verifyPDFMagic(tmpName); err != nil {
		return res, fmt.Errorf("fetch %s: %w", doc.SourceURL, err)
	}

	res.SHA256 = hex.EncodeToString(hasher.Sum(nil))
	res.ByteSize = size

	exists, err := sink.Exists(ctx, res.SHA256)
	if err != nil {
		return res, fmt.Errorf("sink stat %s: %w", res.SHA256, err)
	}
	if exists {
		// Byte-identical to something we already hold (a re-tabled document, or
		// a re-run after a partial failure). Record it without re-uploading.
		res.Deduped = true
		res.StorageURI, err = sinkURIFor(sink, res.SHA256)
		return res, err
	}

	f, err := os.Open(tmpName)
	if err != nil {
		return res, err
	}
	defer func() { _ = f.Close() }()

	uri, stored, err := sink.Put(ctx, res.SHA256, f)
	if err != nil {
		return res, fmt.Errorf("sink put %s: %w", res.SHA256, err)
	}
	if stored != size {
		return res, fmt.Errorf("sink put %s: wrote %d bytes, streamed %d", res.SHA256, stored, size)
	}
	res.StorageURI = uri
	return res, nil
}

// verifyPDFMagic rejects an HTML interstitial served with HTTP 200.
func verifyPDFMagic(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()

	head := make([]byte, len(pdfMagic))
	if _, err := io.ReadFull(f, head); err != nil {
		return fmt.Errorf("read magic: %w", err)
	}
	if string(head) != pdfMagic {
		return fmt.Errorf("body is not a PDF (starts %q) — likely an interstitial served with HTTP 200", string(head))
	}
	return nil
}

// sinkURIFor reconstructs the stored URI for an already-present object.
func sinkURIFor(sink DocumentSink, sha string) (string, error) {
	switch s := sink.(type) {
	case *localSink:
		return "file://" + s.path(sha), nil
	case *gcsSink:
		return fmt.Sprintf("gs://%s/%s", s.bucket, s.object(sha)), nil
	default:
		return "", fmt.Errorf("unknown sink type %T", sink)
	}
}

// fetchWithRetry retries only 429/5xx/transport failures. A 403 and a
// non-PDF body are both terminal.
func fetchWithRetry(ctx context.Context, client *http.Client, doc PendingDocument, sink DocumentSink, maxAttempts int) (FetchResult, error) {
	var lastErr error
	for attempt := range maxAttempts {
		if attempt > 0 {
			backoff := registerRetryBackoff[min(attempt-1, len(registerRetryBackoff)-1)]
			log.Printf("[register-fetch] retry %d/%d in %s: %v", attempt, maxAttempts-1, backoff, lastErr)
			select {
			case <-ctx.Done():
				return FetchResult{}, ctx.Err()
			case <-time.After(backoff):
			}
		}

		res, err := fetchRegisterDocument(ctx, client, doc, sink)
		if err == nil {
			return res, nil
		}
		if _, blocked := errors.AsType[*errBlocked](err); blocked {
			return res, err
		}
		if !isRetryableFetchError(err, res.HTTPStatus) {
			return res, err
		}
		lastErr = err
	}
	return FetchResult{}, lastErr
}

func isRetryableFetchError(err error, status int) bool {
	if err == nil {
		return false
	}
	if status == http.StatusTooManyRequests || status >= 500 {
		return true
	}
	// A transport failure never reached a status code.
	return status == 0
}

func registerFetchDelay() time.Duration {
	return time.Duration(envInt("REGISTER_FETCH_DELAY_MS", defaultRegisterFetchDelayMS)) * time.Millisecond
}

// ---------------------------------------------------------------------------
// Manifest queue
// ---------------------------------------------------------------------------

// selectPendingDocuments returns the fetch queue, newest parliament first so a
// capped run always covers the current parliament.
func selectPendingDocuments(ctx context.Context, pool *pgxpool.Pool, maxAttempts, limit int) ([]PendingDocument, error) {
	q := `
		SELECT id::text, source_url, chamber, fetch_attempts
		FROM register_documents
		WHERE fetch_status IN ('pending', 'failed')
		  AND fetch_attempts < $1
		ORDER BY parliament DESC NULLS LAST, discovered_at`
	args := []any{maxAttempts}
	if limit > 0 {
		q += ` LIMIT $2`
		args = append(args, limit)
	}

	rows, err := pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []PendingDocument
	for rows.Next() {
		var d PendingDocument
		if err := rows.Scan(&d.ID, &d.SourceURL, &d.Chamber, &d.Attempts); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func markDocumentFetched(ctx context.Context, pool *pgxpool.Pool, id string, res FetchResult) error {
	_, err := pool.Exec(ctx, `
		UPDATE register_documents SET
			fetch_status   = 'fetched',
			fetch_attempts = fetch_attempts + 1,
			http_status    = $2,
			fetch_error    = '',
			fetched_at     = now(),
			content_sha256 = $3,
			byte_size      = $4,
			storage_uri    = $5,
			updated_at     = now()
		WHERE id = $1`, id, res.HTTPStatus, res.SHA256, res.ByteSize, res.StorageURI)
	return err
}

// markDocumentFailed records a retryable failure. 'blocked' is terminal and gets
// its own status so the freshness alarm can distinguish a WAF policy change from
// ordinary flakiness.
func markDocumentFailed(ctx context.Context, pool *pgxpool.Pool, id string, status int, blocked bool, cause error) error {
	state := "failed"
	if blocked {
		state = "blocked"
	}
	_, err := pool.Exec(ctx, `
		UPDATE register_documents SET
			fetch_status   = $2,
			fetch_attempts = fetch_attempts + 1,
			http_status    = NULLIF($3, 0),
			fetch_error    = $4,
			updated_at     = now()
		WHERE id = $1`, id, state, status, compactError(cause))
	return err
}

// envInt reads an integer env var, falling back loudly when unparseable.
func envInt(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	var v int
	if _, err := fmt.Sscanf(raw, "%d", &v); err != nil {
		log.Printf("[register] ignoring unparseable %s=%q, using %d", key, raw, fallback)
		return fallback
	}
	return v
}
