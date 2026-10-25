package subscription

import (
	"testing"
	"time"
)

func TestPremiumFeatureTiers(t *testing.T) {
	for _, tier := range []string{"premium", "pro", "enterprise"} {
		if !PremiumFeatureTier(tier) {
			t.Errorf("%s should carry premium features", tier)
		}
	}
	// API Access is a paid API tier and carries none of the premium web features.
	for _, tier := range []string{"api_access", "free", "", "anonymous"} {
		if PremiumFeatureTier(tier) {
			t.Errorf("%q must not carry premium features", tier)
		}
	}
}

func TestAPITokenTiers(t *testing.T) {
	// Every paid tier may mint: token creation is a sold Premium benefit as well as
	// API Access's.
	for _, tier := range []string{"premium", "pro", "enterprise", "api_access"} {
		if !APITokenTier(tier) {
			t.Errorf("%s should be able to mint API tokens", tier)
		}
	}
	for _, tier := range []string{"free", "", "anonymous"} {
		if APITokenTier(tier) {
			t.Errorf("%q must not be able to mint API tokens", tier)
		}
	}
}

func TestPastDueInGrace(t *testing.T) {
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name  string
		since time.Time
		want  bool
	}{
		{"failed one day ago is inside the grace", now.Add(-24 * time.Hour), true},
		{"failed exactly 14 days ago is past the grace", now.Add(-PastDueGrace), false},
		{"failed 15 days ago is past the grace", now.Add(-15 * 24 * time.Hour), false},
		{"no failure time has no grace", time.Time{}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := PastDueInGrace(tc.since, now); got != tc.want {
				t.Fatalf("PastDueInGrace = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestPastDueGraceIsFourteenDays(t *testing.T) {
	if PastDueGrace != 14*24*time.Hour {
		t.Fatalf("PastDueGrace = %v, want 14 days (keep web PAST_DUE_GRACE_MS in step)", PastDueGrace)
	}
}
