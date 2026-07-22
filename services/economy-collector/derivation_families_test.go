package main

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestRunDerivationFamiliesReturnsHealthyObservationsAndAllErrors(t *testing.T) {
	period := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	healthy := Obs{Period: period, Value: 42}
	runs := make([]string, 0, 3)

	obs, err := runDerivationFamilies(
		derivationFamily{
			name: "state markets",
			run: func() ([]Obs, error) {
				runs = append(runs, "state markets")
				return nil, errors.New("produced 0 observations")
			},
		},
		derivationFamily{
			name: "industry markets",
			run: func() ([]Obs, error) {
				runs = append(runs, "industry markets")
				return []Obs{healthy}, nil
			},
		},
		derivationFamily{
			name: "trade balance",
			run: func() ([]Obs, error) {
				runs = append(runs, "trade balance")
				return nil, errors.New("produced 0 observations")
			},
		},
	)

	if got, want := strings.Join(runs, ","), "state markets,industry markets,trade balance"; got != want {
		t.Fatalf("families run = %q, want %q", got, want)
	}
	if len(obs) != 1 || !obs[0].Period.Equal(period) || obs[0].Value != healthy.Value {
		t.Fatalf("observations = %#v, want the healthy family observation", obs)
	}
	if err == nil {
		t.Fatal("error = nil, want joined family errors")
	}
	for _, family := range []string{"state markets", "trade balance"} {
		if !strings.Contains(err.Error(), family) {
			t.Errorf("error = %q, want family name %q", err, family)
		}
	}
}
