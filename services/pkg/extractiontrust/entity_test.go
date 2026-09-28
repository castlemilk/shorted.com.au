package extractiontrust

import "testing"

func TestEntityMatches(t *testing.T) {
	cases := []struct {
		entity, company string
		want            bool
	}{
		// The filings ingest's cases (services/jobs picks TestEntityMatches),
		// verbatim: this is the rule it applies.
		{"BHP Group Limited", "BHP GROUP LIMITED", true},
		{"Commonwealth Bank of Australia", "COMMONWEALTH BANK OF AUSTRALIA.", true},
		{"Fortescue Ltd", "FORTESCUE METALS GROUP LTD", true},
		{"Domino’s Pizza Enterprises Limited", "DOMINO'S PIZZA ENTERPRISES LIMITED", true},
		{"JB Hi-Fi Limited", "JB HI-FI LIMITED", true},
		{"Winsome Resources Limited", "LFT LIMITED", false},
		{"Quokka Minerals Limited", "NORTHERN MINERALS LIMITED", false},
		{"Star Entertainment Group", "NORTHERN STAR RESOURCES LTD", false},
		{"Limited", "BHP GROUP LIMITED", false},
		{"BHP Group Limited", "", false},

		// The stock page's cases, under the one rule.
		{"The Star Entertainment Group Limited", "NORTHERN STAR RESOURCES LTD", false}, // shares only "star": 1 of 2
		{"Winsome Resources Limited", "LINDIAN RESOURCES LIMITED", false},              // an industry word is not an identity
		{"Winsome Lithium Limited", "LINDIAN RESOURCES LIMITED", false},
		{"Lindian Resources Ltd", "LINDIAN RESOURCES LIMITED", true},
		{"National Australia Bank Limited", "NATIONAL AUSTRALIA BANK LIMITED", true},
		{"The a2 Milk Company Limited", "A2 MILK COMPANY LIMITED", true},
		{"DroneShield Limited", "DRONESHIELD LIMITED", true},
		{"Quokka Compounders Limited", "QUOKKA COMPOUNDERS LIMITED", true},
		{"Energy Resources of Australia Ltd", "ENERGY RESOURCES LIMITED", false}, // only industry words: withheld, not guessed
		{"Qantas Airways Limited", "", false},                                    // no company name: unverifiable
		{"", "BHP GROUP LIMITED", false},
		{"Northern Star Resources Limited", "NORTHERN STAR RESOURCES LTD", true},
	}
	for _, c := range cases {
		if got := EntityMatches(c.entity, c.company); got != c.want {
			t.Errorf("EntityMatches(%q, %q) = %v, want %v", c.entity, c.company, got, c.want)
		}
	}
}

func TestEntityTokens(t *testing.T) {
	got := entityTokens("The Domino’s Pizza Enterprises Ltd (ABN 12 345)")
	for _, want := range []string{"dominos", "pizza", "enterprises", "12", "345"} {
		if !got[want] {
			t.Errorf("token %q missing from %v", want, got)
		}
	}
	for _, stop := range []string{"the", "ltd", "abn"} {
		if got[stop] {
			t.Errorf("stop token %q kept", stop)
		}
	}
}
