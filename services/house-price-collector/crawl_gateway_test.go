package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSelectFetcherMode_GatewayPrecedence(t *testing.T) {
	cases := []struct {
		name string
		cfg  crawlConfig
		want fetcherMode
	}{
		{"gateway url set wins over cdp", crawlConfig{gatewayURL: "http://mac:7799", cdpURL: "http://host:9222"}, fetcherModeGateway},
		{"cdp when only cdp", crawlConfig{cdpURL: "http://host:9222"}, fetcherModeCDP},
		{"playwright when neither", crawlConfig{}, fetcherModePlaywright},
		{"explicit override to cdp", crawlConfig{fetchModeOverride: "cdp", gatewayURL: "http://mac:7799"}, fetcherModeCDP},
	}
	for _, c := range cases {
		if got := selectFetcherMode(c.cfg); got != c.want {
			t.Errorf("%s: selectFetcherMode = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestGatewayFetcher_Fetch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sekret" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"kind":"unauthorized","message":"bad token"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"html":"<html>bondi</html>","final_url":"https://x/final","http_status":200,"blocked":false}`))
	}))
	defer srv.Close()

	f, err := newGatewayFetcher(crawlConfig{gatewayURL: srv.URL, gatewayToken: "sekret", fetchTimeout: 5 * time.Second})
	if err != nil {
		t.Fatalf("newGatewayFetcher: %v", err)
	}
	defer f.Close()
	html, finalURL, err := f.fetch(context.Background(), "https://www.realestate.com.au/buy/in-bondi/list-1")
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if string(html) != "<html>bondi</html>" || finalURL != "https://x/final" {
		t.Errorf("got html=%q finalURL=%q", html, finalURL)
	}
}

func TestGatewayFetcher_NeedsRewarmError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"error":{"kind":"needs_rewarm","message":"clearance expired"}}`))
	}))
	defer srv.Close()
	f, _ := newGatewayFetcher(crawlConfig{gatewayURL: srv.URL, fetchTimeout: 5 * time.Second})
	_, _, err := f.fetch(context.Background(), "https://x")
	if !errors.Is(err, errGatewayNeedsRewarm) {
		t.Errorf("want errGatewayNeedsRewarm, got %v", err)
	}
}
