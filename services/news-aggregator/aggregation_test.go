package main

import (
	"context"
	"errors"
	"strings"
	"testing"
)

type fakeFetcher struct {
	err   error
	calls int
}

func (f *fakeFetcher) Fetch(context.Context, NewsSource, int) ([]*NewsArticleRaw, error) {
	f.calls++
	return nil, f.err
}

type fakeStore struct{}

func (fakeStore) StoreArticles(context.Context, []*NewsArticleRaw) (int, error) {
	return 0, nil
}

func TestAggregateSourcesFailsWhenAllSourcesFail(t *testing.T) {
	fetcher := &fakeFetcher{err: errors.New("feed unavailable")}
	sources := []NewsSource{
		{Name: "Source A", URL: "https://example.com/a.xml"},
		{Name: "Source B", URL: "https://example.com/b.xml"},
	}

	_, err := aggregateSources(
		context.Background(),
		fetcher,
		newTestMatcher(),
		fakeStore{},
		sources,
		100,
		false,
		false,
	)

	if err == nil {
		t.Fatal("expected all-source fetch failure to fail the aggregation")
	}
	if !strings.Contains(err.Error(), "all 2 news sources failed") {
		t.Fatalf("unexpected error: %v", err)
	}
	if fetcher.calls != len(sources) {
		t.Fatalf("fetch calls = %d, want %d", fetcher.calls, len(sources))
	}
}
