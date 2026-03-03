// Package stealthhttp provides a stealth-powered HTTP client for web scraping.
// It wraps the stealth engine to provide TLS fingerprinting, anti-detection headers,
// and browser-like request behavior while maintaining a simple API compatible with
// existing goquery-based scraping code.
package stealthhttp

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
	"github.com/skunkworq/stealth/brws/engine"
	_ "github.com/skunkworq/stealth/brws/engine/native" // Register native engine
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	otelmetric "go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

var (
	tracer = otel.Tracer("shorted.stealthhttp")
	meter  = otel.Meter("shorted.stealthhttp")

	fetchDuration otelmetric.Float64Histogram
	fetchTotal    otelmetric.Int64Counter
	fetchErrors   otelmetric.Int64Counter
	fetchBytes    otelmetric.Int64Counter
)

func init() {
	fetchDuration, _ = meter.Float64Histogram(
		"shorted.stealth.fetch_duration",
		otelmetric.WithDescription("Duration of stealth HTTP fetch requests in seconds"),
		otelmetric.WithUnit("s"),
	)
	fetchTotal, _ = meter.Int64Counter(
		"shorted.stealth.fetch_total",
		otelmetric.WithDescription("Total number of stealth HTTP fetch requests"),
	)
	fetchErrors, _ = meter.Int64Counter(
		"shorted.stealth.fetch_errors",
		otelmetric.WithDescription("Total number of stealth HTTP fetch errors"),
	)
	fetchBytes, _ = meter.Int64Counter(
		"shorted.stealth.fetch_bytes",
		otelmetric.WithDescription("Total bytes fetched via stealth HTTP"),
		otelmetric.WithUnit("By"),
	)
}

// Client wraps a stealth engine for HTTP scraping.
type Client struct {
	engine       engine.Engine
	engineName   string
	timeout      time.Duration
	maxRedirects int
}

// config holds options for creating a Client.
type config struct {
	engineName   string
	timeout      time.Duration
	maxRedirects int
	profileName  string
	headless     bool
}

// Option configures a Client.
type Option func(*config)

// WithTimeout sets the per-request timeout.
func WithTimeout(d time.Duration) Option {
	return func(c *config) { c.timeout = d }
}

// WithMaxRedirects sets the maximum number of redirects to follow.
func WithMaxRedirects(n int) Option {
	return func(c *config) { c.maxRedirects = n }
}

// WithTLSProfile sets the browser TLS profile to emulate (e.g. "chrome-120-macos").
func WithTLSProfile(profile string) Option {
	return func(c *config) { c.profileName = profile }
}

// New creates a native stealth client with TLS fingerprinting.
// The native engine is fast, requires no browser process, and handles
// TLS fingerprint spoofing + realistic browser headers automatically.
func New(opts ...Option) (*Client, error) {
	cfg := &config{
		engineName:   "native",
		timeout:      30 * time.Second,
		maxRedirects: 10,
		profileName:  "chrome-120-macos",
		headless:     true,
	}
	for _, opt := range opts {
		opt(cfg)
	}

	eng, err := engine.New(cfg.engineName, engine.Options{
		Headless:    cfg.headless,
		Stealth:     true,
		StealthTLS:  true,
		ProfileName: cfg.profileName,
		Timeout:     cfg.timeout,
	})
	if err != nil {
		return nil, fmt.Errorf("stealthhttp: create engine: %w", err)
	}

	return &Client{
		engine:       eng,
		engineName:   cfg.engineName,
		timeout:      cfg.timeout,
		maxRedirects: cfg.maxRedirects,
	}, nil
}

// NewChromium creates a chromium-backed client with JS rendering and challenge solving.
// Use this for sites that require JavaScript execution (e.g. LinkedIn).
func NewChromium(opts ...Option) (*Client, error) {
	cfg := &config{
		engineName:   "chromium",
		timeout:      30 * time.Second,
		maxRedirects: 10,
		profileName:  "chrome-120-macos",
		headless:     true,
	}
	for _, opt := range opts {
		opt(cfg)
	}

	eng, err := engine.New(cfg.engineName, engine.Options{
		Headless:    cfg.headless,
		Stealth:     true,
		StealthTLS:  true,
		ProfileName: cfg.profileName,
		Timeout:     cfg.timeout,
	})
	if err != nil {
		return nil, fmt.Errorf("stealthhttp: create chromium engine: %w", err)
	}

	return &Client{
		engine:       eng,
		engineName:   cfg.engineName,
		timeout:      cfg.timeout,
		maxRedirects: cfg.maxRedirects,
	}, nil
}

// urlHost extracts the host from a URL for use as a span/metric attribute.
func urlHost(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "unknown"
	}
	return u.Host
}

// recordFetch records metrics and span attributes for a completed fetch.
func (c *Client) recordFetch(ctx context.Context, span trace.Span, start time.Time, reqURL string, status int, bodyLen int, err error) {
	duration := time.Since(start).Seconds()
	host := urlHost(reqURL)
	attrs := []attribute.KeyValue{
		attribute.String("stealth.engine", c.engineName),
		attribute.String("http.host", host),
	}

	if err != nil {
		span.SetStatus(codes.Error, err.Error())
		span.SetAttributes(attribute.String("error.message", err.Error()))
		fetchErrors.Add(ctx, 1, otelmetric.WithAttributes(attrs...))
	} else {
		span.SetStatus(codes.Ok, "")
		span.SetAttributes(
			attribute.Int("http.status_code", status),
			attribute.Int("http.response_content_length", bodyLen),
		)
		fetchBytes.Add(ctx, int64(bodyLen), otelmetric.WithAttributes(attrs...))
	}

	fetchDuration.Record(ctx, duration, otelmetric.WithAttributes(attrs...))
	fetchTotal.Add(ctx, 1, otelmetric.WithAttributes(append(attrs,
		attribute.String("status", statusLabel(err, status)),
	)...))
}

func statusLabel(err error, status int) string {
	if err != nil {
		return "error"
	}
	if status >= 200 && status < 300 {
		return "success"
	}
	return fmt.Sprintf("%d", status)
}

// FetchHTML fetches a page and returns a goquery Document.
// This is a drop-in replacement for the pattern:
//
//	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
//	req.Header.Set("User-Agent", "...")
//	resp, _ := client.Do(req)
//	doc, _ := goquery.NewDocumentFromReader(resp.Body)
func (c *Client) FetchHTML(ctx context.Context, pageURL string) (*goquery.Document, *url.URL, error) {
	ctx, span := tracer.Start(ctx, "stealth.fetch_html",
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("http.url", pageURL),
			attribute.String("stealth.engine", c.engineName),
		),
	)
	defer span.End()
	start := time.Now()

	resp, err := c.engine.Do(ctx, &engine.Request{
		Method:          "GET",
		URL:             pageURL,
		FollowRedirects: true,
		MaxRedirects:    c.maxRedirects,
		Timeout:         c.timeout,
	})
	if err != nil {
		c.recordFetch(ctx, span, start, pageURL, 0, 0, err)
		return nil, nil, err
	}

	if resp.Status < 200 || resp.Status >= 300 {
		err := fmt.Errorf("unexpected status: %d", resp.Status)
		c.recordFetch(ctx, span, start, pageURL, resp.Status, len(resp.Body), err)
		return nil, nil, err
	}

	c.recordFetch(ctx, span, start, pageURL, resp.Status, len(resp.Body), nil)

	doc, err := goquery.NewDocumentFromReader(bytes.NewReader(resp.Body))
	if err != nil {
		return nil, nil, err
	}

	// Determine the final URL (after redirects)
	finalURL := pageURL
	if resp.FinalURL != "" {
		finalURL = resp.FinalURL
	}
	base, err := url.Parse(finalURL)
	if err != nil {
		return nil, nil, err
	}

	return doc, base, nil
}

// FetchBytes fetches raw bytes from a URL (for images, PDFs, etc.).
func (c *Client) FetchBytes(ctx context.Context, pageURL string, acceptHeader string) ([]byte, string, error) {
	ctx, span := tracer.Start(ctx, "stealth.fetch_bytes",
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("http.url", pageURL),
			attribute.String("stealth.engine", c.engineName),
		),
	)
	defer span.End()
	start := time.Now()

	headers := make(map[string][]string)
	if acceptHeader != "" {
		headers["Accept"] = []string{acceptHeader}
	}

	resp, err := c.engine.Do(ctx, &engine.Request{
		Method:          "GET",
		URL:             pageURL,
		Headers:         headers,
		FollowRedirects: true,
		MaxRedirects:    c.maxRedirects,
		Timeout:         c.timeout,
	})
	if err != nil {
		c.recordFetch(ctx, span, start, pageURL, 0, 0, err)
		return nil, "", err
	}

	if resp.Status < 200 || resp.Status >= 300 {
		err := fmt.Errorf("unexpected status: %d", resp.Status)
		c.recordFetch(ctx, span, start, pageURL, resp.Status, len(resp.Body), err)
		return nil, "", err
	}

	c.recordFetch(ctx, span, start, pageURL, resp.Status, len(resp.Body), nil)

	// Extract content-type from response headers
	contentType := ""
	if ct, ok := resp.Headers["Content-Type"]; ok && len(ct) > 0 {
		contentType = ct[0]
	}
	if contentType == "" {
		if ct, ok := resp.Headers["content-type"]; ok && len(ct) > 0 {
			contentType = ct[0]
		}
	}

	return resp.Body, contentType, nil
}

// FetchHTMLWithLimit fetches a page and returns a goquery Document, limiting response body size.
func (c *Client) FetchHTMLWithLimit(ctx context.Context, pageURL string, maxBytes int64) (*goquery.Document, *url.URL, error) {
	ctx, span := tracer.Start(ctx, "stealth.fetch_html",
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("http.url", pageURL),
			attribute.String("stealth.engine", c.engineName),
			attribute.Int64("http.max_bytes", maxBytes),
		),
	)
	defer span.End()
	start := time.Now()

	resp, err := c.engine.Do(ctx, &engine.Request{
		Method:          "GET",
		URL:             pageURL,
		FollowRedirects: true,
		MaxRedirects:    c.maxRedirects,
		Timeout:         c.timeout,
	})
	if err != nil {
		c.recordFetch(ctx, span, start, pageURL, 0, 0, err)
		return nil, nil, err
	}

	if resp.Status < 200 || resp.Status >= 300 {
		err := fmt.Errorf("unexpected status: %d", resp.Status)
		c.recordFetch(ctx, span, start, pageURL, resp.Status, len(resp.Body), err)
		return nil, nil, err
	}

	c.recordFetch(ctx, span, start, pageURL, resp.Status, len(resp.Body), nil)

	body := resp.Body
	if maxBytes > 0 && int64(len(body)) > maxBytes {
		body = body[:maxBytes]
	}

	doc, err := goquery.NewDocumentFromReader(bytes.NewReader(body))
	if err != nil {
		return nil, nil, err
	}

	finalURL := pageURL
	if resp.FinalURL != "" {
		finalURL = resp.FinalURL
	}
	base, err := url.Parse(finalURL)
	if err != nil {
		return nil, nil, err
	}

	return doc, base, nil
}

// FetchBytesWithLimit fetches raw bytes with a size limit.
func (c *Client) FetchBytesWithLimit(ctx context.Context, pageURL string, acceptHeader string, maxBytes int64) ([]byte, string, error) {
	data, contentType, err := c.FetchBytes(ctx, pageURL, acceptHeader)
	if err != nil {
		return nil, "", err
	}

	if maxBytes > 0 && int64(len(data)) > maxBytes {
		// Wrap in a LimitReader-like pattern for consistency with existing code
		r := io.LimitReader(bytes.NewReader(data), maxBytes)
		limited, err := io.ReadAll(r)
		if err != nil {
			return nil, "", err
		}
		return limited, contentType, nil
	}

	return data, contentType, nil
}

// Do executes a raw engine request for custom use cases.
func (c *Client) Do(ctx context.Context, req *engine.Request) (*engine.Response, error) {
	ctx, span := tracer.Start(ctx, "stealth.do",
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("http.method", req.Method),
			attribute.String("http.url", req.URL),
			attribute.String("stealth.engine", c.engineName),
		),
	)
	defer span.End()
	start := time.Now()

	if req.Timeout == 0 {
		req.Timeout = c.timeout
	}
	resp, err := c.engine.Do(ctx, req)
	if err != nil {
		c.recordFetch(ctx, span, start, req.URL, 0, 0, err)
		return nil, err
	}
	c.recordFetch(ctx, span, start, req.URL, resp.Status, len(resp.Body), nil)
	return resp, nil
}

// Close releases engine resources.
func (c *Client) Close() error {
	if c.engine != nil {
		return c.engine.Close()
	}
	return nil
}

// StatusError returns the HTTP status code from an error message if it matches
// the "unexpected status: NNN" pattern. Returns 0 if not a status error.
func StatusError(err error) int {
	if err == nil {
		return 0
	}
	msg := err.Error()
	if strings.HasPrefix(msg, "unexpected status: ") {
		var code int
		if _, scanErr := fmt.Sscanf(msg, "unexpected status: %d", &code); scanErr == nil {
			return code
		}
	}
	return 0
}
