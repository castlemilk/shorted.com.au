package enrichment

import "testing"

func TestVerifyEmployment(t *testing.T) {
	tests := []struct {
		name        string
		result      *LinkedInPersonResult
		companyName string
		stockCode   string
		want        bool
	}{
		{
			name: "exact company name match in headline",
			result: &LinkedInPersonResult{
				Headline:        "CEO at BHP Group Limited",
				ExperienceTitle: "",
			},
			companyName: "BHP Group Limited",
			stockCode:   "BHP",
			want:        true,
		},
		{
			name: "partial company name match (core name)",
			result: &LinkedInPersonResult{
				Headline:        "Managing Director at BHP",
				ExperienceTitle: "BHP Group | Rio Tinto",
			},
			companyName: "BHP Group Limited",
			stockCode:   "BHP",
			want:        true,
		},
		{
			name: "stock code match as word",
			result: &LinkedInPersonResult{
				Headline:        "Executive at some firm",
				ExperienceTitle: "Previously at CSL, now at Macquarie",
			},
			companyName: "CSL Limited",
			stockCode:   "CSL",
			want:        true,
		},
		{
			name: "no match — different company",
			result: &LinkedInPersonResult{
				Headline:        "CEO at Google",
				ExperienceTitle: "Google | Microsoft | Amazon",
			},
			companyName: "BHP Group Limited",
			stockCode:   "BHP",
			want:        false,
		},
		{
			name: "stock code substring should NOT match",
			result: &LinkedInPersonResult{
				Headline:        "Working on CSLR project",
				ExperienceTitle: "",
			},
			companyName: "CSL Limited",
			stockCode:   "CSL",
			want:        false, // CSLR contains CSL but is not a word match
		},
		{
			name: "company name in experience section",
			result: &LinkedInPersonResult{
				Headline:        "Experienced mining executive",
				ExperienceTitle: "Fortescue Metals Group | BHP Billiton",
			},
			companyName: "Fortescue Metals Group Limited",
			stockCode:   "FMG",
			want:        true,
		},
		{
			name: "nil result",
			result: nil,
			companyName: "BHP",
			stockCode:   "BHP",
			want:        false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := verifyEmployment(tt.result, tt.companyName, tt.stockCode)
			if got != tt.want {
				t.Errorf("verifyEmployment() = %v, want %v (headline=%q, experience=%q)",
					got, tt.want, tt.result.Headline, tt.result.ExperienceTitle)
			}
		})
	}
}

func TestPersonNameToLinkedInProfileSlug(t *testing.T) {
	tests := []struct {
		name string
		want string
	}{
		{"John Smith", "john-smith"},
		{"Dr. Jane Doe", "jane-doe"},
		{"Mr. Robert Jones MBA", "robert-jones"},
		{"Sarah O'Connor", "sarah-oconnor"},
		{"", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := personNameToLinkedInProfileSlug(tt.name)
			if got != tt.want {
				t.Errorf("personNameToLinkedInProfileSlug(%q) = %q, want %q", tt.name, got, tt.want)
			}
		})
	}
}

func TestExtractCoreCompanyName(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"bhp group limited", "bhp"},
		{"csl limited", "csl"},
		{"fortescue metals group limited", "fortescue metals"},
		{"rio tinto", "rio tinto"},
		{"commonwealth bank of australia", "commonwealth bank of"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := extractCoreCompanyName(tt.input)
			if got != tt.want {
				t.Errorf("extractCoreCompanyName(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestContainsWord(t *testing.T) {
	tests := []struct {
		text string
		word string
		want bool
	}{
		{"working at csl limited", "csl", true},
		{"working on cslr project", "csl", false},
		{"csl is a great company", "csl", true},
		{"company: csl", "csl", true},
		{"abccsldef", "csl", false},
	}

	for _, tt := range tests {
		t.Run(tt.text+"_"+tt.word, func(t *testing.T) {
			got := containsWord(tt.text, tt.word)
			if got != tt.want {
				t.Errorf("containsWord(%q, %q) = %v, want %v", tt.text, tt.word, got, tt.want)
			}
		})
	}
}

func TestIsLinkedInProfileURL(t *testing.T) {
	tests := []struct {
		url  string
		want bool
	}{
		{"https://www.linkedin.com/in/john-smith", true},
		{"https://linkedin.com/in/jane-doe-123abc", true},
		{"https://au.linkedin.com/in/someone", true},
		{"https://www.linkedin.com/company/bhp", false},
		{"https://twitter.com/in/john", false},
		{"", false},
	}

	for _, tt := range tests {
		t.Run(tt.url, func(t *testing.T) {
			got := isLinkedInProfileURL(tt.url)
			if got != tt.want {
				t.Errorf("isLinkedInProfileURL(%q) = %v, want %v", tt.url, got, tt.want)
			}
		})
	}
}
