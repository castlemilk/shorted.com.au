package enrichment

import (
	"context"
	"testing"
	"time"
)

// TestFindAndVerifyPersonE2E calls the actual FindAndVerifyPerson method end-to-end.
func TestFindAndVerifyPersonE2E(t *testing.T) {
	requireExternalEnrichmentTests(t, "LinkedIn end-to-end tests")

	tests := []struct {
		personName  string
		personRole  string
		companyName string
		stockCode   string
		expectNil   bool // true if person is known to have no public LinkedIn profile
	}{
		{"Mike Henry", "CEO", "BHP Group Limited", "BHP", false},
		{"Paul Perreault", "CEO", "CSL Limited", "CSL", false},
		{"Steven Marks", "CEO", "Guzman Y Gomez Limited", "GYG", false},
		{"Matt Comyn", "CEO", "Commonwealth Bank of Australia", "CBA", false},
		{"Jakob Stausholm", "CEO", "Rio Tinto Limited", "RIO", false},
		{"Andrew Forrest", "Chairman", "Fortescue Metals Group Limited", "FMG", false}, // Profile: drandrewforrest (uses "Dr" title)
		{"Brad Banducci", "CEO", "Woolworths Group Limited", "WOW", false},
		{"Vicki Brady", "CEO", "Telstra Group Limited", "TLS", false},
	}

	client := NewLinkedInPersonClient(nil) // No Exa
	defer client.Close()

	for _, tt := range tests {
		t.Run(tt.personName, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()

			result, err := client.FindAndVerifyPerson(ctx, tt.personName, tt.personRole, tt.companyName, tt.stockCode)
			if err != nil {
				t.Fatalf("FindAndVerifyPerson failed: %v", err)
			}

			if tt.expectNil {
				if result == nil {
					t.Logf("OK: %s has no public LinkedIn profile (expected nil)", tt.personName)
				} else {
					t.Logf("Bonus: found %s despite expecting nil — profileURL=%q", tt.personName, result.ProfileURL)
				}
				return
			}

			if result == nil {
				t.Errorf("FindAndVerifyPerson returned nil — expected a result")
				return
			}

			t.Logf("Result: name=%q profileURL=%q imageURL=%q", result.Name, result.ProfileURL, result.ImageURL)
			t.Logf("  headline=%q", result.Headline)
			t.Logf("  companyVerified=%v matchedCompany=%q source=%q", result.CompanyVerified, result.MatchedCompany, result.Source)

			if !result.CompanyVerified {
				t.Errorf("Expected company verification to pass")
			}
			if result.ProfileURL == "" {
				t.Errorf("Expected a profile URL")
			}
		})
	}
}
