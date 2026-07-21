package enrichment

import (
	"math"
	"testing"
)

func sumWeights(entries []StateExposure) float64 {
	total := 0.0
	for _, e := range entries {
		total += e.Weight
	}
	return total
}

func TestValidateStateExposure_ValidPassThrough(t *testing.T) {
	raw := []StateExposure{
		{Region: "wa", Weight: 0.55, Basis: "Pilbara iron ore operations"},
		{Region: "qld", Weight: 0.2, Basis: "Coking coal mines"},
		{Region: "sa", Weight: 0.1, Basis: "Olympic Dam copper"},
		{Region: "international", Weight: 0.15, Basis: "Americas potash and copper"},
	}

	got, err := ValidateStateExposure(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 4 {
		t.Fatalf("expected 4 entries, got %d", len(got))
	}
	for i, e := range raw {
		if got[i].Region != e.Region {
			t.Errorf("entry %d region = %q, want %q", i, got[i].Region, e.Region)
		}
		if math.Abs(got[i].Weight-e.Weight) > 1e-9 {
			t.Errorf("entry %d weight = %v, want %v", i, got[i].Weight, e.Weight)
		}
		if got[i].Basis != e.Basis {
			t.Errorf("entry %d basis = %q, want %q", i, got[i].Basis, e.Basis)
		}
	}
	if s := sumWeights(got); math.Abs(s-1.0) > 1e-9 {
		t.Errorf("weights sum = %v, want exactly 1.0", s)
	}
}

func TestValidateStateExposure_RenormalizesLowSum(t *testing.T) {
	// Sums to 0.9 — must renormalize to exactly 1.0
	raw := []StateExposure{
		{Region: "nsw", Weight: 0.45, Basis: "Sydney operations"},
		{Region: "vic", Weight: 0.45, Basis: "Melbourne operations"},
	}

	got, err := ValidateStateExposure(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(got))
	}
	if s := sumWeights(got); math.Abs(s-1.0) > 1e-9 {
		t.Errorf("weights sum = %v, want exactly 1.0", s)
	}
	if math.Abs(got[0].Weight-0.5) > 1e-9 || math.Abs(got[1].Weight-0.5) > 1e-9 {
		t.Errorf("weights = %v/%v, want 0.5/0.5", got[0].Weight, got[1].Weight)
	}
}

func TestValidateStateExposure_RenormalizesHighSum(t *testing.T) {
	// Sums to 1.2 — must renormalize to exactly 1.0
	raw := []StateExposure{
		{Region: "qld", Weight: 0.6, Basis: "Queensland mines"},
		{Region: "wa", Weight: 0.6, Basis: "Western Australia mines"},
	}

	got, err := ValidateStateExposure(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s := sumWeights(got); math.Abs(s-1.0) > 1e-9 {
		t.Errorf("weights sum = %v, want exactly 1.0", s)
	}
	if math.Abs(got[0].Weight-0.5) > 1e-9 || math.Abs(got[1].Weight-0.5) > 1e-9 {
		t.Errorf("weights = %v/%v, want 0.5/0.5", got[0].Weight, got[1].Weight)
	}
}

func TestValidateStateExposure_DropsInvalidRegionThenRenormalizes(t *testing.T) {
	raw := []StateExposure{
		{Region: "wa", Weight: 0.5, Basis: "Iron ore"},
		{Region: "zz", Weight: 0.25, Basis: "Bogus region"},
		{Region: "vic", Weight: 0.25, Basis: "Head office ops"},
	}

	got, err := ValidateStateExposure(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 entries after dropping invalid region, got %d", len(got))
	}
	if got[0].Region != "wa" || got[1].Region != "vic" {
		t.Errorf("regions = %s/%s, want wa/vic", got[0].Region, got[1].Region)
	}
	// 0.5/0.75 ≈ 0.67, 0.25/0.75 ≈ 0.33 (2dp, sum exactly 1.0)
	if s := sumWeights(got); math.Abs(s-1.0) > 1e-9 {
		t.Errorf("weights sum = %v, want exactly 1.0", s)
	}
	if math.Abs(got[1].Weight-0.33) > 1e-9 {
		t.Errorf("vic weight = %v, want 0.33", got[1].Weight)
	}
	if math.Abs(got[0].Weight-0.67) > 1e-9 {
		t.Errorf("wa weight = %v, want 0.67", got[0].Weight)
	}
}

func TestValidateStateExposure_AllInvalidErrors(t *testing.T) {
	raw := []StateExposure{
		{Region: "narnia", Weight: 0.5, Basis: "Nope"},
		{Region: "usa", Weight: 0.5, Basis: "Should be international"},
	}
	if _, err := ValidateStateExposure(raw); err == nil {
		t.Fatal("expected error for all-invalid regions, got nil")
	}
}

func TestValidateStateExposure_EmptyErrors(t *testing.T) {
	if _, err := ValidateStateExposure(nil); err == nil {
		t.Fatal("expected error for empty input, got nil")
	}
}

func TestValidateStateExposure_TooManyEntriesErrors(t *testing.T) {
	raw := []StateExposure{
		{Region: "nsw", Weight: 0.14, Basis: "a"},
		{Region: "vic", Weight: 0.14, Basis: "b"},
		{Region: "qld", Weight: 0.14, Basis: "c"},
		{Region: "sa", Weight: 0.14, Basis: "d"},
		{Region: "wa", Weight: 0.14, Basis: "e"},
		{Region: "tas", Weight: 0.15, Basis: "f"},
		{Region: "nt", Weight: 0.15, Basis: "g"},
	}
	if _, err := ValidateStateExposure(raw); err == nil {
		t.Fatal("expected error for >6 entries, got nil")
	}
}

func TestValidateStateExposure_DropsZeroAndNegativeWeights(t *testing.T) {
	raw := []StateExposure{
		{Region: "wa", Weight: 0.5, Basis: "Mining"},
		{Region: "vic", Weight: 0, Basis: "Zero"},
		{Region: "qld", Weight: -0.2, Basis: "Negative"},
		{Region: "nsw", Weight: 0.5, Basis: "Retail network"},
	}

	got, err := ValidateStateExposure(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(got))
	}
	if got[0].Region != "wa" || got[1].Region != "nsw" {
		t.Errorf("regions = %s/%s, want wa/nsw", got[0].Region, got[1].Region)
	}
	if s := sumWeights(got); math.Abs(s-1.0) > 1e-9 {
		t.Errorf("weights sum = %v, want exactly 1.0", s)
	}
}

func TestValidateStateExposure_NormalizesRegionCase(t *testing.T) {
	raw := []StateExposure{
		{Region: " WA ", Weight: 0.6, Basis: "Mining"},
		{Region: "International", Weight: 0.4, Basis: "Offshore ops"},
	}

	got, err := ValidateStateExposure(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got[0].Region != "wa" || got[1].Region != "international" {
		t.Errorf("regions = %q/%q, want wa/international", got[0].Region, got[1].Region)
	}
}
