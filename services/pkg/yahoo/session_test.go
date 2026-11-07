package yahoo

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"testing"
)

// fakeFetcher answers by URL prefix and records every call.
type fakeFetcher struct {
	calls   []fakeCall
	answers []func(rawURL string, header map[string]string) (*Response, error)
}

type fakeCall struct {
	url    string
	header map[string]string
}

func (f *fakeFetcher) Get(_ context.Context, rawURL string, header map[string]string) (*Response, error) {
	f.calls = append(f.calls, fakeCall{url: rawURL, header: header})
	if len(f.answers) == 0 {
		return &Response{Status: 500}, nil
	}
	a := f.answers[0]
	if len(f.answers) > 1 {
		f.answers = f.answers[1:]
	}
	return a(rawURL, header)
}

func page(rawURL string, _ map[string]string) (*Response, error) {
	return &Response{Status: 200, SetCookie: []string{"A3=abc; Domain=.yahoo.com; Path=/; Secure", "GUC=xyz; Path=/"}}, nil
}

func crumb(_ string, _ map[string]string) (*Response, error) {
	return &Response{Status: 200, Body: []byte("crumb-1\n")}, nil
}

func summaryOK(raw string) func(string, map[string]string) (*Response, error) {
	return func(string, map[string]string) (*Response, error) {
		return &Response{Status: 200, Body: []byte(raw)}, nil
	}
}

const bhpBody = `{"quoteSummary":{"result":[{"price":{"regularMarketPrice":{"raw":45.1,"fmt":"45.10"}}}],"error":null}}`

func TestQuoteSummaryRunsCrumbAndCookieFlowOnce(t *testing.T) {
	f := &fakeFetcher{answers: []func(string, map[string]string) (*Response, error){
		page, crumb, summaryOK(bhpBody), summaryOK(bhpBody),
	}}
	s := NewSession(f)

	raw, err := s.QuoteSummary(context.Background(), "BHP.AX", []string{"price", "summaryDetail"})
	if err != nil {
		t.Fatalf("QuoteSummary: %v", err)
	}
	if !strings.Contains(string(raw), "regularMarketPrice") {
		t.Fatalf("result = %s, want the price module", raw)
	}
	if _, err := s.QuoteSummary(context.Background(), "BHP.AX", []string{"price"}); err != nil {
		t.Fatalf("second QuoteSummary: %v", err)
	}

	if len(f.calls) != 4 {
		t.Fatalf("calls = %d, want 4 (page, crumb, two summaries: the crumb is cached)", len(f.calls))
	}
	if f.calls[1].header["Cookie"] != "A3=abc; GUC=xyz" {
		t.Errorf("crumb request Cookie = %q, want the page's cookies without attributes", f.calls[1].header["Cookie"])
	}
	u, err := url.Parse(f.calls[2].url)
	if err != nil {
		t.Fatal(err)
	}
	if got := u.Query().Get("crumb"); got != "crumb-1" {
		t.Errorf("crumb = %q, want crumb-1 (trimmed)", got)
	}
	if got := u.Query().Get("modules"); got != "price,summaryDetail" {
		t.Errorf("modules = %q", got)
	}
	if !strings.HasSuffix(u.Path, "/BHP.AX") {
		t.Errorf("path = %q, want the symbol", u.Path)
	}
	if f.calls[2].header["Cookie"] != "A3=abc; GUC=xyz" {
		t.Errorf("summary Cookie = %q", f.calls[2].header["Cookie"])
	}
}

func TestQuoteSummaryRefreshesCrumbOnceOn401(t *testing.T) {
	f := &fakeFetcher{answers: []func(string, map[string]string) (*Response, error){
		page, crumb,
		func(string, map[string]string) (*Response, error) { return &Response{Status: 401}, nil },
		page, // the refresh drops the cookies too, so the page is fetched again
		func(string, map[string]string) (*Response, error) {
			return &Response{Status: 200, Body: []byte("crumb-2")}, nil
		},
		summaryOK(bhpBody),
	}}
	s := NewSession(f)
	if _, err := s.QuoteSummary(context.Background(), "BHP.AX", []string{"price"}); err != nil {
		t.Fatalf("QuoteSummary after a 401: %v", err)
	}
	if n := len(f.calls); n != 6 {
		t.Fatalf("calls = %d, want 6 (page, crumb, 401, page, crumb, summary); got urls %v", n, f.urls())
	}
	u, _ := url.Parse(f.calls[len(f.calls)-1].url)
	if u.Query().Get("crumb") != "crumb-2" {
		t.Errorf("retry used crumb %q, want the refreshed one", u.Query().Get("crumb"))
	}
}

func (f *fakeFetcher) urls() []string {
	out := make([]string, 0, len(f.calls))
	for _, c := range f.calls {
		out = append(out, c.url)
	}
	return out
}

func TestQuoteSummaryAnswersThatAreNotQuotes(t *testing.T) {
	tests := []struct {
		name       string
		status     int
		body       string
		wantNil    bool
		wantNotFnd bool
		wantErr    bool
	}{
		{name: "no result and no error is no data", status: 200, body: `{"quoteSummary":{"result":null,"error":null}}`, wantNil: true},
		{name: "not found is an answer", status: 404, body: `{"quoteSummary":{"result":null,"error":{"code":"Not Found","description":"Quote not found for symbol: ZZZ.AX"}}}`, wantNotFnd: true, wantErr: true},
		{name: "rate limit is a failure", status: 429, body: `Too Many Requests`, wantErr: true},
		{name: "error block on 200", status: 200, body: `{"quoteSummary":{"result":null,"error":{"code":"Unauthorized","description":"x"}}}`, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := &fakeFetcher{answers: []func(string, map[string]string) (*Response, error){
				page, crumb, summaryOK(tt.body),
			}}
			if tt.status != 200 {
				f.answers[2] = func(string, map[string]string) (*Response, error) {
					return &Response{Status: tt.status, Body: []byte(tt.body)}, nil
				}
			}
			raw, err := NewSession(f).QuoteSummary(context.Background(), "ZZZ.AX", []string{"price"})
			if tt.wantNil {
				if raw != nil || err != nil {
					t.Fatalf("got (%s, %v), want (nil, nil)", raw, err)
				}
				return
			}
			if tt.wantErr != (err != nil) {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if IsNotFound(err) != tt.wantNotFnd {
				t.Errorf("IsNotFound = %v, want %v (err %v)", IsNotFound(err), tt.wantNotFnd, err)
			}
			var ae *APIError
			if err != nil && !errors.As(err, &ae) {
				t.Errorf("err %v is not an *APIError", err)
			}
		})
	}
}

func TestQuoteSummaryTransportFailureIsPlainError(t *testing.T) {
	f := &fakeFetcher{answers: []func(string, map[string]string) (*Response, error){
		func(string, map[string]string) (*Response, error) { return nil, errors.New("dial tcp: refused") },
	}}
	_, err := NewSession(f).QuoteSummary(context.Background(), "BHP.AX", []string{"price"})
	if err == nil || IsNotFound(err) {
		t.Fatalf("err = %v, want a transport error that is not not-found", err)
	}
}

func TestDecodeSummaryReturnsTheFirstResultVerbatim(t *testing.T) {
	raw, err := decodeSummary(200, []byte(bhpBody))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]json.RawMessage
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("result is not an object: %v", err)
	}
	if _, ok := got["price"]; !ok {
		t.Fatalf("result keys = %v, want price", got)
	}
}

func TestCookieHeaderKeepsOnlyPairs(t *testing.T) {
	got := cookieHeader([]string{"a=1; Path=/", "noeq; Path=/", " b = 2 ; Secure"})
	if got != "a=1; b = 2" {
		t.Errorf("cookieHeader = %q", got)
	}
}
