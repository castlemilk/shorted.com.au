package enrichment

import (
	"testing"
)

func TestGenerateLinkedInSlugs(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		wantLen  int
		wantSlug string // first expected slug, empty if none
	}{
		{"Dr with first last", "Dr Andrew Forrest", 2, "drandrewforrest"},
		{"Dr. with period", "Dr. Guido Arnout", 2, "drguidoarnout"},
		{"Dr with qualifications", "Dr. Andreas Fouras M.A.I.C.D., Ph.D.", 2, "drandreasfourasmaicd"},
		{"Mr - no Dr title", "Mr. Matthew Blake Sandblom", 0, ""},
		{"Plain name - no Dr", "Andrew Gee", 0, ""},
		{"Mr with qualifications", "Mr. Ian Peter Olson AICD, AIMM, B.Com.", 0, ""},
		{"Placeholder John Doe", "John Doe", 0, ""},
		{"Placeholder Jane Smith", "Jane Smith", 0, ""},
		{"Non-person phrase", "READY TO THRIVE?", 0, ""},
		{"Company name", "Alfabs Group", 0, ""},
		{"Empty", "", 0, ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			slugs := generateLinkedInSlugs(tt.input)
			if len(slugs) != tt.wantLen {
				t.Errorf("generateLinkedInSlugs(%q) returned %d slugs, want %d: %v", tt.input, len(slugs), tt.wantLen, slugs)
			}
			if tt.wantSlug != "" && len(slugs) > 0 && slugs[0] != tt.wantSlug {
				t.Errorf("generateLinkedInSlugs(%q) first slug = %q, want %q", tt.input, slugs[0], tt.wantSlug)
			}
		})
	}
}

func TestIsPlaceholderName(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  bool
	}{
		{"John Doe", "John Doe", true},
		{"Jane Smith", "Jane Smith", true},
		{"N/A", "N/A", true},
		{"Empty", "", true},
		{"Single word", "Andrew", true},
		{"Ready to thrive", "READY TO THRIVE?", true},
		{"Creating Impact", "Creating Impact", true},
		{"Our Commitment", "Our Commitment", true},
		{"Company name", "Alfabs Group", true},
		{"Real name", "Andrew Forrest", false},
		{"Real name Dr", "Dr. Guido Arnout", false},
		{"Real name Mr", "Mr. Matthew Sandblom", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := IsPlaceholderName(tt.input)
			if got != tt.want {
				t.Errorf("IsPlaceholderName(%q) = %v, want %v", tt.input, got, tt.want)
			}
		})
	}
}
