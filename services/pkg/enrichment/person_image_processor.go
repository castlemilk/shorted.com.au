package enrichment

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"

	"cloud.google.com/go/storage"
)

// PersonImageProcessor downloads person images and uploads them to GCS
type PersonImageProcessor struct {
	gcsClient  *storage.Client
	bucketName string
	httpClient *http.Client
}

// NewPersonImageProcessor creates a new person image processor
func NewPersonImageProcessor(gcsClient *storage.Client, bucketName string) *PersonImageProcessor {
	return &PersonImageProcessor{
		gcsClient:  gcsClient,
		bucketName: bucketName,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// ProcessAndUpload downloads a person's image and uploads it to GCS.
// Returns the GCS public URL of the uploaded image.
func (p *PersonImageProcessor) ProcessAndUpload(ctx context.Context, imageURL, stockCode, personName string) (string, error) {
	if imageURL == "" {
		return "", fmt.Errorf("image URL is empty")
	}
	if stockCode == "" {
		return "", fmt.Errorf("stock code is empty")
	}

	// Download image
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, imageURL, nil)
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("User-Agent", "Shorted.com.au/1.0")

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to download image: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("image download returned status %d", resp.StatusCode)
	}

	// Validate content type
	contentType := resp.Header.Get("Content-Type")
	ext := extensionFromContentType(contentType)
	if ext == "" {
		// Try to infer from URL
		ext = extensionFromURL(imageURL)
	}
	if ext == "" {
		return "", fmt.Errorf("unsupported image content type: %s", contentType)
	}

	// Read body with size limit (5MB)
	limitedReader := io.LimitReader(resp.Body, 5*1024*1024)
	data, err := io.ReadAll(limitedReader)
	if err != nil {
		return "", fmt.Errorf("failed to read image data: %w", err)
	}

	// Validate minimum size (1KB)
	if len(data) < 1024 {
		return "", fmt.Errorf("image too small (%d bytes)", len(data))
	}

	// Upload to GCS
	sanitizedName := sanitizePersonName(personName)
	objectName := fmt.Sprintf("people/%s/%s.%s", strings.ToUpper(stockCode), sanitizedName, ext)

	bucket := p.gcsClient.Bucket(p.bucketName)
	wc := bucket.Object(objectName).NewWriter(ctx)
	wc.ContentType = contentType
	wc.CacheControl = "public, max-age=31536000, immutable"

	if _, err := wc.Write(data); err != nil {
		_ = wc.Close()
		return "", fmt.Errorf("failed to write to GCS: %w", err)
	}
	if err := wc.Close(); err != nil {
		return "", fmt.Errorf("failed to close GCS writer: %w", err)
	}

	gcsURL := fmt.Sprintf("https://storage.googleapis.com/%s/%s", p.bucketName, objectName)
	return gcsURL, nil
}

// UploadFromBytes uploads pre-downloaded image bytes to GCS.
// Used when images can't be fetched via plain HTTP (e.g., LinkedIn authenticated images).
func (p *PersonImageProcessor) UploadFromBytes(ctx context.Context, data []byte, contentType, stockCode, personName string) (string, error) {
	if len(data) < 1024 {
		return "", fmt.Errorf("image too small (%d bytes)", len(data))
	}

	ext := extensionFromContentType(contentType)
	if ext == "" {
		// Default to jpg for LinkedIn images
		ext = "jpg"
		contentType = "image/jpeg"
	}

	sanitizedName := sanitizePersonName(personName)
	objectName := fmt.Sprintf("people/%s/%s.%s", strings.ToUpper(stockCode), sanitizedName, ext)

	bucket := p.gcsClient.Bucket(p.bucketName)
	wc := bucket.Object(objectName).NewWriter(ctx)
	wc.ContentType = contentType
	wc.CacheControl = "public, max-age=31536000, immutable"

	if _, err := wc.Write(data); err != nil {
		_ = wc.Close()
		return "", fmt.Errorf("failed to write to GCS: %w", err)
	}
	if err := wc.Close(); err != nil {
		return "", fmt.Errorf("failed to close GCS writer: %w", err)
	}

	gcsURL := fmt.Sprintf("https://storage.googleapis.com/%s/%s", p.bucketName, objectName)
	return gcsURL, nil
}

// sanitizePersonName converts a person name to a safe filename
var nonAlphaNum = regexp.MustCompile(`[^a-z0-9]+`)

func sanitizePersonName(name string) string {
	lower := strings.ToLower(strings.TrimSpace(name))
	// Remove accents/diacritics by keeping only ASCII
	cleaned := strings.Map(func(r rune) rune {
		if r > unicode.MaxASCII {
			return -1
		}
		return r
	}, lower)
	sanitized := nonAlphaNum.ReplaceAllString(cleaned, "_")
	sanitized = strings.Trim(sanitized, "_")
	if sanitized == "" {
		sanitized = "unknown"
	}
	return sanitized
}

func extensionFromContentType(ct string) string {
	ct = strings.ToLower(ct)
	switch {
	case strings.Contains(ct, "image/jpeg"):
		return "jpg"
	case strings.Contains(ct, "image/png"):
		return "png"
	case strings.Contains(ct, "image/webp"):
		return "webp"
	default:
		return ""
	}
}

func extensionFromURL(rawURL string) string {
	ext := strings.ToLower(filepath.Ext(rawURL))
	switch ext {
	case ".jpg", ".jpeg":
		return "jpg"
	case ".png":
		return "png"
	case ".webp":
		return "webp"
	default:
		return ""
	}
}
