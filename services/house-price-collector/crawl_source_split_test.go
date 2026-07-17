package main

import (
	"reflect"
	"testing"
)

func TestEnqueueSources(t *testing.T) {
	cases := map[string][]string{
		"":         {"rea", "domain"}, // default → split
		"split":    {"rea", "domain"},
		"SPLIT":    {"rea", "domain"},
		"rea":      {"rea"},
		"domain":   {"domain"},
		" Domain ": {"domain"},
		"both":     {"both"}, // legacy single combined job
		"nonsense": {"rea", "domain"},
	}
	for in, want := range cases {
		if got := enqueueSources(in); !reflect.DeepEqual(got, want) {
			t.Errorf("enqueueSources(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestWantSource(t *testing.T) {
	cases := []struct {
		portal, jobSource string
		want              bool
	}{
		{"rea", "rea", true},
		{"rea", "domain", false},
		{"domain", "domain", true},
		{"domain", "rea", false},
		// legacy / unset → crawl every portal (backward compatible)
		{"rea", "both", true},
		{"domain", "both", true},
		{"rea", "", true},
		{"domain", "", true},
		// case / whitespace tolerant
		{"rea", "REA", true},
		{"domain", " Domain ", true},
	}
	for _, c := range cases {
		if got := wantSource(c.portal, c.jobSource); got != c.want {
			t.Errorf("wantSource(%q, %q) = %v, want %v", c.portal, c.jobSource, got, c.want)
		}
	}
}
