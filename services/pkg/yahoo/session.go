// Package yahoo is the shared Yahoo Finance quoteSummary plumbing: the
// cookie-and-crumb session Yahoo requires for that endpoint, behind a Fetcher
// so the same flow runs over net/http (enrichment) or the stealth client
// (the jobs monolith, which Yahoo answers 429 to from a plain client).
//
// The session carries its own cookies. The stealth engine keeps no cookie jar,
// so the Set-Cookie pairs from the quote page are sent back by hand on the
// crumb and quoteSummary requests, which is what the browser would do.
package yahoo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
)

const (
	// quotePage is visited once for session cookies. The symbol is incidental:
	// Yahoo sets the same cookies on any quote page.
	quotePage     = "https://finance.yahoo.com/quote/BHP.AX"
	crumbEndpoint = "https://query2.finance.yahoo.com/v1/test/getcrumb"
	summaryBase   = "https://query2.finance.yahoo.com/v10/finance/quoteSummary/"
)

// APIError is an answer Yahoo gave that is not a quote: an HTTP status other
// than 200 (after the one crumb refresh on 401), or an error block in the body.
type APIError struct {
	Status      int
	Code        string
	Description string
}

func (e *APIError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("yahoo quoteSummary: status %d: %s - %s", e.Status, e.Code, e.Description)
	}
	return fmt.Sprintf("yahoo quoteSummary: status %d", e.Status)
}

// IsNotFound reports whether Yahoo answered that it does not carry the symbol.
// That is an answer, not an outage: a caller treats it as no data.
func IsNotFound(err error) bool {
	var ae *APIError
	if !errors.As(err, &ae) {
		return false
	}
	return ae.Status == 404 || strings.EqualFold(ae.Code, "Not Found")
}

// Session fetches quoteSummary documents with a cached crumb and cookies. It is
// safe for concurrent use; the crumb is fetched once and refreshed on a 401.
type Session struct {
	fetch Fetcher

	mu      sync.Mutex
	crumb   string
	cookies string
}

// NewSession returns a session that fetches through f.
func NewSession(f Fetcher) *Session {
	return &Session{fetch: f}
}

// QuoteSummary returns the first entry of quoteSummary.result for symbol (for
// example "BHP.AX") with the given modules, as the raw JSON object keyed by
// module name. It returns (nil, nil) when Yahoo answers 200 with no result and
// no error. It returns *APIError for every other answer that is not a quote.
// A transport failure or a crumb failure is returned as a plain error.
func (s *Session) QuoteSummary(ctx context.Context, symbol string, modules []string) (json.RawMessage, error) {
	if strings.TrimSpace(symbol) == "" {
		return nil, errors.New("yahoo: symbol is required")
	}
	body, status, err := s.summary(ctx, symbol, modules)
	if err != nil {
		return nil, err
	}
	return decodeSummary(status, body)
}

// summary performs the request, refreshing the crumb once on a 401.
func (s *Session) summary(ctx context.Context, symbol string, modules []string) ([]byte, int, error) {
	for attempt := 0; attempt < 2; attempt++ {
		crumb, cookies, err := s.session(ctx, attempt > 0)
		if err != nil {
			return nil, 0, err
		}
		rawURL := fmt.Sprintf("%s%s?modules=%s&crumb=%s", summaryBase, url.PathEscape(symbol),
			url.QueryEscape(strings.Join(modules, ",")), url.QueryEscape(crumb))
		resp, err := s.fetch.Get(ctx, rawURL, map[string]string{
			"Accept": "application/json",
			"Cookie": cookies,
		})
		if err != nil {
			return nil, 0, fmt.Errorf("yahoo quoteSummary %s: %w", symbol, err)
		}
		if resp.Status == 401 && attempt == 0 {
			s.invalidate()
			continue
		}
		return resp.Body, resp.Status, nil
	}
	return nil, 0, errors.New("yahoo quoteSummary: unauthorised after a crumb refresh")
}

// session returns the cached crumb and cookie header, or fetches them. force
// discards the cache first.
func (s *Session) session(ctx context.Context, force bool) (string, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if force {
		s.crumb, s.cookies = "", ""
	}
	if s.crumb != "" {
		return s.crumb, s.cookies, nil
	}

	// Step 1: the quote page sets the session cookies.
	page, err := s.fetch.Get(ctx, quotePage, map[string]string{
		"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	})
	if err != nil {
		return "", "", fmt.Errorf("yahoo session: %w", err)
	}
	cookies := cookieHeader(page.SetCookie)

	// Step 2: the crumb, with those cookies.
	crumbResp, err := s.fetch.Get(ctx, crumbEndpoint, map[string]string{"Cookie": cookies})
	if err != nil {
		return "", "", fmt.Errorf("yahoo crumb: %w", err)
	}
	if crumbResp.Status != 200 {
		return "", "", fmt.Errorf("yahoo crumb: status %d: %s", crumbResp.Status, truncate(crumbResp.Body, 512))
	}
	crumb := strings.TrimSpace(string(truncateBytes(crumbResp.Body, 256)))
	if crumb == "" {
		return "", "", errors.New("yahoo crumb: empty")
	}
	s.crumb, s.cookies = crumb, cookies
	return crumb, cookies, nil
}

func (s *Session) invalidate() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.crumb, s.cookies = "", ""
}

// quoteSummaryBody is the envelope Yahoo wraps every quoteSummary answer in.
type quoteSummaryBody struct {
	QuoteSummary struct {
		Result []json.RawMessage `json:"result"`
		Error  *struct {
			Code        string `json:"code"`
			Description string `json:"description"`
		} `json:"error"`
	} `json:"quoteSummary"`
}

// decodeSummary turns one answer into the first result, or into an error.
func decodeSummary(status int, body []byte) (json.RawMessage, error) {
	var env quoteSummaryBody
	decodeErr := json.Unmarshal(body, &env)
	if env.QuoteSummary.Error != nil {
		return nil, &APIError{Status: status, Code: env.QuoteSummary.Error.Code, Description: env.QuoteSummary.Error.Description}
	}
	if status != 200 {
		return nil, &APIError{Status: status, Description: truncate(body, 200)}
	}
	if decodeErr != nil {
		return nil, fmt.Errorf("yahoo quoteSummary: decode: %w", decodeErr)
	}
	if len(env.QuoteSummary.Result) == 0 || string(env.QuoteSummary.Result[0]) == "null" {
		return nil, nil
	}
	return env.QuoteSummary.Result[0], nil
}

// cookieHeader joins Set-Cookie values into a Cookie request header: the
// name=value pair of each, attributes dropped.
func cookieHeader(setCookie []string) string {
	pairs := make([]string, 0, len(setCookie))
	for _, sc := range setCookie {
		pair, _, _ := strings.Cut(sc, ";")
		pair = strings.TrimSpace(pair)
		if strings.Contains(pair, "=") {
			pairs = append(pairs, pair)
		}
	}
	return strings.Join(pairs, "; ")
}

func truncate(b []byte, n int) string {
	return string(truncateBytes(b, n))
}

func truncateBytes(b []byte, n int) []byte {
	if len(b) > n {
		return b[:n]
	}
	return b
}

// ReadLimit is the most body the fetchers keep from one answer. A quoteSummary
// document with four modules is a few kilobytes.
const ReadLimit = 1 << 20
