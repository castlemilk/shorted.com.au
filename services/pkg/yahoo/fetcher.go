package yahoo

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/skunkworq/stealth/brws/engine"

	"github.com/castlemilk/shorted.com.au/services/pkg/stealthhttp"
)

// Response is one answer from a Fetcher. A non-2xx status is an answer, not an
// error: the session decides what it means.
type Response struct {
	Status    int
	Body      []byte
	SetCookie []string
}

// Fetcher performs one GET. header holds the request headers the session needs
// (Accept, Cookie); a fetcher adds nothing else that would change the answer
// (the stealth client supplies its own browser headers and User-Agent).
type Fetcher interface {
	Get(ctx context.Context, rawURL string, header map[string]string) (*Response, error)
}

// HTTPFetcher fetches with net/http. It keeps no cookie jar: the Session sends
// the cookies it collected itself. UserAgent is set on every request when
// non-empty.
type HTTPFetcher struct {
	Client    *http.Client
	UserAgent string
}

// Get implements Fetcher.
func (f *HTTPFetcher) Get(ctx context.Context, rawURL string, header map[string]string) (*Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, fmt.Errorf("yahoo: build request: %w", err)
	}
	for k, v := range header {
		if v != "" {
			req.Header.Set(k, v)
		}
	}
	if f.UserAgent != "" {
		req.Header.Set("User-Agent", f.UserAgent)
	}
	resp, err := f.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, ReadLimit))
	if err != nil {
		return nil, fmt.Errorf("yahoo: read body: %w", err)
	}
	return &Response{Status: resp.StatusCode, Body: body, SetCookie: resp.Header.Values("Set-Cookie")}, nil
}

// StealthFetcher fetches through the stealth client, the only path Yahoo has
// not answered 429 on from the jobs runners (marketdata/providers, picks).
type StealthFetcher struct {
	Client *stealthhttp.Client
}

// Get implements Fetcher.
func (f *StealthFetcher) Get(ctx context.Context, rawURL string, header map[string]string) (*Response, error) {
	headers := make(map[string][]string, len(header))
	for k, v := range header {
		if v != "" {
			headers[k] = []string{v}
		}
	}
	resp, err := f.Client.Do(ctx, &engine.Request{
		Method:          http.MethodGet,
		URL:             rawURL,
		Headers:         headers,
		FollowRedirects: true,
		MaxRedirects:    10,
	})
	if err != nil {
		return nil, err
	}
	var setCookie []string
	for k, vs := range resp.Headers {
		if strings.EqualFold(k, "Set-Cookie") {
			setCookie = append(setCookie, vs...)
		}
	}
	body := resp.Body
	if len(body) > ReadLimit {
		body = body[:ReadLimit]
	}
	return &Response{Status: resp.Status, Body: body, SetCookie: setCookie}, nil
}
