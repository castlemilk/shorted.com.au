package enrichment

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/PuerkitoBio/goquery"
	"github.com/castlemilk/shorted.com.au/services/pkg/stealthhttp"
)

// TestDebugStrategies traces all 3 strategies for failing cases.
func TestDebugStrategies(t *testing.T) {
	if testing.Short() {
		t.Skip("requires network + chromium")
	}

	tests := []struct {
		personName  string
		personRole  string
		companyName string
		stockCode   string
	}{
		{"Andrew Forrest", "Chairman", "Fortescue Metals Group Limited", "FMG"},
	}

	chromClient, err := stealthhttp.NewChromium(stealthhttp.WithTimeout(25 * time.Second))
	if err != nil {
		t.Fatalf("Chromium: %v", err)
	}
	defer func() { _ = chromClient.Close() }()

	// Quick test: try direct URL probe for drandrewforrest
	{
		ctx0, cancel0 := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel0()
		t.Log("Direct probe: https://www.linkedin.com/in/drandrewforrest/")
		doc, finalURL, probeErr := chromClient.FetchHTML(ctx0, "https://www.linkedin.com/in/drandrewforrest/")
		if probeErr != nil {
			t.Logf("  Fetch error: %v", probeErr)
		} else {
			t.Logf("  Fetch OK, finalURL=%v", finalURL)
			result := extractLinkedInPersonData(doc, "https://www.linkedin.com/in/drandrewforrest/")
			if result == nil {
				t.Logf("  extractLinkedInPersonData returned nil")
				t.Logf("  Page title: %q", doc.Find("title").Text())
				t.Logf("  Page body (first 500 chars): %q", truncate(doc.Text(), 500))
			} else {
				t.Logf("  name=%q headline=%q image=%q", result.Name, result.Headline, result.ImageURL)
				t.Logf("  Experience: %q", truncate(result.ExperienceTitle, 300))
				verified := verifyEmployment(result, "Fortescue Metals Group Limited", "FMG")
				t.Logf("  Employment verified: %v (matched=%q)", verified, result.MatchedCompany)
			}
		}
	}

	for _, tt := range tests {
		t.Run(tt.personName, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
			defer cancel()

			nameParts := strings.Fields(strings.ToLower(tt.personName))
			searchCompany := extractCoreCompanyName(strings.ToLower(tt.companyName))
			roleTerms := simplifyRole(tt.personRole)

			// Strategy A
			qA := fmt.Sprintf("site:linkedin.com/in \"%s\" \"%s\"", tt.personName, searchCompany)
			t.Logf("Strategy A: %s", qA)
			candA := testSearchDDG(t, ctx, chromClient, qA, nameParts)
			t.Logf("  → %d candidates", len(candA))

			// Strategy B
			time.Sleep(3 * time.Second)
			qB := fmt.Sprintf("linkedin.com/in \"%s\" %s %s", tt.personName, searchCompany, roleTerms)
			t.Logf("Strategy B: %s", qB)
			candB := testSearchDDG(t, ctx, chromClient, qB, nameParts)
			t.Logf("  → %d candidates", len(candB))

			// For each Strategy B candidate, try scraping
			for i, c := range candB {
				if i >= 2 {
					break
				}
				time.Sleep(3 * time.Second)
				t.Logf("  Scraping candidate %d: %s", i, c.profileURL)
				doc, finalURL, scrapeErr := chromClient.FetchHTML(ctx, c.profileURL)
				if scrapeErr != nil {
					t.Logf("    Scrape error: %v", scrapeErr)
					continue
				}
				t.Logf("    Scrape OK, finalURL=%v", finalURL)

				result := extractLinkedInPersonData(doc, c.profileURL)
				if result == nil {
					t.Logf("    extractLinkedInPersonData returned nil")
					continue
				}
				t.Logf("    Extracted: name=%q headline=%q image=%q", result.Name, result.Headline, result.ImageURL)
				t.Logf("    Experience: %q", truncate(result.ExperienceTitle, 200))

				verified := verifyEmployment(result, tt.companyName, tt.stockCode)
				t.Logf("    Employment verified: %v (matched=%q)", verified, result.MatchedCompany)
			}

			// Strategy C
			time.Sleep(3 * time.Second)
			qC := fmt.Sprintf("site:linkedin.com/in \"%s\"", tt.personName)
			t.Logf("Strategy C: %s", qC)
			candC := testSearchDDG(t, ctx, chromClient, qC, nameParts)
			t.Logf("  → %d candidates", len(candC))
			for i, c := range candC {
				if i >= 3 {
					break
				}
				t.Logf("  Candidate %d: %s text=%q", i, c.profileURL, truncate(c.searchText, 150))
			}

			// Strategy D: Try with honorific prefixes
			for _, prefix := range []string{"Dr ", "Professor "} {
				titledName := prefix + tt.personName
				titledParts := strings.Fields(strings.ToLower(titledName))

				time.Sleep(3 * time.Second)
				qD1 := fmt.Sprintf("linkedin.com/in \"%s\" %s %s", titledName, searchCompany, roleTerms)
				t.Logf("Strategy D (%s + company): %s", prefix, qD1)
				candD1 := testSearchDDG(t, ctx, chromClient, qD1, titledParts)
				t.Logf("  → %d candidates", len(candD1))

				time.Sleep(3 * time.Second)
				qD2 := fmt.Sprintf("site:linkedin.com/in \"%s\"", titledName)
				t.Logf("Strategy D (%s name-only): %s", prefix, qD2)
				candD2 := testSearchDDG(t, ctx, chromClient, qD2, titledParts)
				t.Logf("  → %d candidates", len(candD2))
				for i, c := range candD2 {
					if i >= 3 {
						break
					}
					t.Logf("  Candidate %d: %s text=%q", i, c.profileURL, truncate(c.searchText, 200))
				}
			}
		})
	}
}

func testSearchDDG(t *testing.T, ctx context.Context, chromClient *stealthhttp.Client, query string, nameParts []string) []ddgCandidate {
	t.Helper()
	ddgURL := fmt.Sprintf("https://duckduckgo.com/?q=%s", url.QueryEscape(query))
	doc, _, err := chromClient.FetchHTML(ctx, ddgURL)
	if err != nil {
		t.Logf("  DDG fetch error: %v", err)
		return nil
	}

	type linkedInLink struct {
		href    string
		texts   []string
		snippet string
	}
	var liLinks []linkedInLink
	liLinkIndex := map[string]int{}

	doc.Find("a").Each(func(_ int, s *goquery.Selection) {
		href, _ := s.Attr("href")
		if strings.Contains(href, "uddg=") {
			if u, parseErr := url.Parse(href); parseErr == nil {
				if actual := u.Query().Get("uddg"); actual != "" {
					href = actual
				}
			}
		}
		if !strings.Contains(href, "linkedin.com/in/") {
			return
		}
		text := strings.TrimSpace(s.Text())
		if text == "" {
			return
		}
		var snippet string
		parent := s.Closest("article, .result, .nrn-react-div, [data-testid='result']")
		if parent.Length() > 0 {
			snippet = strings.TrimSpace(parent.Text())
		}
		if idx, ok := liLinkIndex[href]; ok {
			liLinks[idx].texts = append(liLinks[idx].texts, text)
			if snippet != "" && len(snippet) > len(liLinks[idx].snippet) {
				liLinks[idx].snippet = snippet
			}
		} else {
			liLinkIndex[href] = len(liLinks)
			liLinks = append(liLinks, linkedInLink{href: href, texts: []string{text}, snippet: snippet})
		}
	})

	var results []ddgCandidate
	for _, link := range liLinks {
		allText := strings.Join(link.texts, " | ")
		if link.snippet != "" {
			allText += " | " + link.snippet
		}
		allTextLower := strings.ToLower(allText)
		matchCount := 0
		for _, part := range nameParts {
			if strings.Contains(allTextLower, part) {
				matchCount++
			}
		}
		if matchCount >= len(nameParts) {
			results = append(results, ddgCandidate{profileURL: link.href, searchText: allText})
			t.Logf("  Match: %s text=%q", link.href, truncate(allText, 200))
		}
	}
	return results
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
