package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIndustrySourceDefinitionsAreUniqueAndGated(t *testing.T) {
	seen := map[string]bool{}
	for _, source := range industrySourceDefinitions {
		if source.SourceKey == "" {
			t.Fatal("source key must not be empty")
		}
		if seen[source.SourceKey] {
			t.Fatalf("duplicate source key %q", source.SourceKey)
		}
		seen[source.SourceKey] = true

		if source.SourceURL == "" || source.DisplayName == "" || source.SignalKind == "" {
			t.Fatalf("source %q is missing required display metadata: %+v", source.SourceKey, source)
		}
	}

	for _, required := range []string{
		"asic-short-interest",
		"ato-corporate-tax-transparency",
		"abs-international-trade-goods",
		"abs-input-output-tables",
		"austender-contract-notices",
		"grantconnect-awards",
		"aec-transparency-register",
		"agd-register-lobbyists",
		"agd-fits-register",
		"cer-nger-corporate-emissions",
	} {
		if !seen[required] {
			t.Fatalf("missing required source definition %q", required)
		}
	}

	for _, source := range industrySourceDefinitions {
		if source.SourceKey == "asic-short-interest" || source.SourceKey == "ato-corporate-tax-transparency" {
			if !source.PublicEnabled {
				t.Fatalf("%s should be publicly enabled because it has imported/live records", source.SourceKey)
			}
			continue
		}
		if source.PublicEnabled {
			t.Fatalf("%s must stay public-disabled until records are imported and reviewed", source.SourceKey)
		}
	}
}

func TestProbeIndustrySource(t *testing.T) {
	for _, tc := range []struct {
		name     string
		status   int
		wantCode int
		wantErr  bool
	}{
		{name: "success", status: http.StatusNoContent, wantCode: http.StatusNoContent},
		{name: "failure", status: http.StatusInternalServerError, wantCode: http.StatusInternalServerError, wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if got := r.Header.Get("User-Agent"); got != influenceUA {
					t.Fatalf("User-Agent = %q, want %q", got, influenceUA)
				}
				w.WriteHeader(tc.status)
			}))
			defer server.Close()

			source := IndustrySourceDefinition{
				SourceKey: "test-source",
				ProbeURL:  server.URL,
			}
			gotCode, err := probeIndustrySource(context.Background(), server.Client(), source)
			if gotCode != tc.wantCode {
				t.Fatalf("status code = %d, want %d", gotCode, tc.wantCode)
			}
			if tc.wantErr && err == nil {
				t.Fatal("expected probe error")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected probe error: %v", err)
			}
			if got := classifyProbeStatus(err); got != map[bool]string{true: "failed", false: "succeeded"}[tc.wantErr] {
				t.Fatalf("classifyProbeStatus = %q", got)
			}
		})
	}
}

func TestCompactError(t *testing.T) {
	if got := compactError(nil); got != "" {
		t.Fatalf("compactError(nil) = %q", got)
	}

	err := fmt.Errorf("  %s  ", strings.Repeat("x", 600))
	got := compactError(err)
	if len(got) != 500 {
		t.Fatalf("compactError length = %d, want 500", len(got))
	}
	if strings.HasPrefix(got, " ") || strings.HasSuffix(got, " ") {
		t.Fatalf("compactError should trim whitespace: %q", got)
	}
}
