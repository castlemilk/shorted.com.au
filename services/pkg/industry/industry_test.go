package industry

import "testing"

// The cases mirror the web behaviour in web/src/@/lib/industry-slug.ts and
// web/src/@/lib/industry-placeholder.ts, so an alert target the web links to
// is the one the evaluator matches.
func TestSlug(t *testing.T) {
	cases := map[string]string{
		"Health Care Equipment & Services": "health-care-equipment-services",
		"health care equipment services":   "health-care-equipment-services",
		"  Materials  ":                    "materials",
		"Consumer Staples (Food)":          "consumer-staples-food",
		"--Banks--":                        "banks",
		"Real Estate":                      "real-estate",
		"":                                 "",
		"!!!":                              "",
	}
	for in, want := range cases {
		if got := Slug(in); got != want {
			t.Errorf("Slug(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestIsPlaceholder(t *testing.T) {
	for _, name := range []string{"Not Applic", "NOT APPLICABLE", "Class Pend", "other", "Other", "", "   "} {
		if !IsPlaceholder(name) {
			t.Errorf("IsPlaceholder(%q) = false, want true", name)
		}
	}
	for _, name := range []string{"Materials", "Not Applic Holdings", "Other Financials", "Banks"} {
		if IsPlaceholder(name) {
			t.Errorf("IsPlaceholder(%q) = true, want false", name)
		}
	}
}

func TestIsPlaceholderSlug(t *testing.T) {
	for _, slug := range []string{"", "not-applic", "not-applicable", "class-pend", "other"} {
		if !IsPlaceholderSlug(slug) {
			t.Errorf("IsPlaceholderSlug(%q) = false, want true", slug)
		}
	}
	for _, slug := range []string{"materials", "not-applic-holdings"} {
		if IsPlaceholderSlug(slug) {
			t.Errorf("IsPlaceholderSlug(%q) = true, want false", slug)
		}
	}
}
