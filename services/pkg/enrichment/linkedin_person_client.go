package enrichment

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
	"github.com/castlemilk/shorted.com.au/services/pkg/stealthhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

var linkedInTracer = otel.Tracer("shorted.enrichment.linkedin_person")

// LinkedInPersonResult contains person data found via LinkedIn
type LinkedInPersonResult struct {
	Name            string `json:"name"`
	ProfileURL      string `json:"profile_url"`
	ImageURL        string `json:"image_url"`
	Headline        string `json:"headline"`
	CompanyVerified bool   `json:"company_verified"`
	MatchedCompany  string `json:"matched_company"`
	ExperienceTitle string `json:"experience_title"`
	Source          string `json:"source"` // "exa", "linkedin_direct", "search"
}

// LinkedInPersonClient finds LinkedIn profile photos with employment verification.
//
// Strategy:
//  1. Exa AI (if available) — returns LinkedIn URLs, images, and text snippets.
//  2. DuckDuckGo search → find LinkedIn profile URL + verify from snippet.
//  3. Direct LinkedIn scrape via Chromium stealth → extract profile photo + experience.
type LinkedInPersonClient struct {
	exaClient   ExaClient
	chromClient *stealthhttp.Client // reusable Chromium client
	lastCall    time.Time
	callDelay   time.Duration
}

// NewLinkedInPersonClient creates a new LinkedIn person client.
func NewLinkedInPersonClient(exaClient ExaClient) *LinkedInPersonClient {
	return &LinkedInPersonClient{
		exaClient: exaClient,
		callDelay: 3 * time.Second,
	}
}

// Close releases the Chromium client.
func (c *LinkedInPersonClient) Close() {
	if c.chromClient != nil {
		_ = c.chromClient.Close()
		c.chromClient = nil
	}
}

func (c *LinkedInPersonClient) getChromClient() (*stealthhttp.Client, error) {
	if c.chromClient != nil {
		return c.chromClient, nil
	}
	client, err := stealthhttp.NewChromium(stealthhttp.WithTimeout(25 * time.Second))
	if err != nil {
		return nil, err
	}
	c.chromClient = client
	return client, nil
}

// resetChromClient closes the current Chromium client and forces a new one on next call.
func (c *LinkedInPersonClient) resetChromClient() {
	if c.chromClient != nil {
		_ = c.chromClient.Close()
		c.chromClient = nil
	}
}

func (c *LinkedInPersonClient) rateLimit() {
	if !c.lastCall.IsZero() {
		elapsed := time.Since(c.lastCall)
		if elapsed < c.callDelay {
			time.Sleep(c.callDelay - elapsed)
		}
	}
	c.lastCall = time.Now()
}

// FindAndVerifyPerson searches for a person's LinkedIn profile, extracts their
// photo, and verifies they work at the target company.
func (c *LinkedInPersonClient) FindAndVerifyPerson(ctx context.Context, personName, personRole, companyName, stockCode string) (*LinkedInPersonResult, error) {
	ctx, span := linkedInTracer.Start(ctx, "linkedin.find_and_verify_person",
		trace.WithAttributes(
			attribute.String("person_name", personName),
			attribute.String("person_role", personRole),
			attribute.String("company_name", companyName),
			attribute.String("stock_code", stockCode),
		),
	)
	defer span.End()

	personName = strings.TrimSpace(personName)
	if personName == "" {
		return nil, fmt.Errorf("person name is required")
	}

	// Skip placeholder/non-person names early
	if IsPlaceholderName(personName) {
		return nil, nil
	}

	cleanName := cleanPersonNameForSearch(personName)
	if cleanName == "" {
		cleanName = personName
	}

	// Strategy 1: Exa AI
	if c.exaClient != nil {
		result, err := c.findViaExa(ctx, cleanName, personRole, companyName, stockCode)
		if err != nil {
			span.AddEvent("exa_failed", trace.WithAttributes(attribute.String("error", err.Error())))
		}
		if result != nil {
			span.SetAttributes(attribute.String("linkedin.source", "exa"))
			span.SetStatus(codes.Ok, "")
			return result, nil
		}
	}

	// Strategy 2: Search engine → find profile URL → scrape directly
	result, err := c.findViaSearchAndScrape(ctx, cleanName, personRole, companyName, stockCode)
	if err != nil {
		span.AddEvent("search_scrape_failed", trace.WithAttributes(attribute.String("error", err.Error())))
		return nil, err
	}
	if result != nil {
		span.SetAttributes(
			attribute.String("linkedin.source", result.Source),
			attribute.String("linkedin.profile_url", result.ProfileURL),
			attribute.Bool("linkedin.company_verified", result.CompanyVerified),
		)
		span.SetStatus(codes.Ok, "")
		return result, nil
	}

	span.AddEvent("no_verified_profile_found")
	return nil, nil
}

// findViaExa uses Exa AI to search for a person's LinkedIn profile.
func (c *LinkedInPersonClient) findViaExa(ctx context.Context, personName, personRole, companyName, stockCode string) (*LinkedInPersonResult, error) {
	if c.exaClient == nil {
		return nil, nil
	}

	searchResult, err := c.exaClient.SearchPeople(ctx, companyName, personName, personRole)
	if err != nil {
		return nil, fmt.Errorf("exa search failed: %w", err)
	}
	if searchResult == nil || len(searchResult.Results) == 0 {
		return nil, nil
	}

	var bestLinkedIn *ExaResult
	var bestImageURL string

	for i := range searchResult.Results {
		res := &searchResult.Results[i]
		if bestImageURL == "" && res.Image != "" {
			bestImageURL = res.Image
		}
		if bestLinkedIn == nil && isLinkedInProfileURL(res.URL) {
			bestLinkedIn = res
			if res.Image != "" {
				bestImageURL = res.Image
			}
		}
	}

	if bestLinkedIn == nil && bestImageURL == "" {
		return nil, nil
	}

	result := &LinkedInPersonResult{
		Name:     personName,
		ImageURL: bestImageURL,
		Source:   "exa",
	}

	if bestLinkedIn != nil {
		result.ProfileURL = bestLinkedIn.URL
		result.Headline = bestLinkedIn.Title
	}

	var allText strings.Builder
	for _, res := range searchResult.Results {
		allText.WriteString(" " + res.Title + " " + res.Text)
	}
	result.ExperienceTitle = allText.String()
	result.CompanyVerified = verifyEmployment(result, companyName, stockCode)

	if !result.CompanyVerified || result.ImageURL == "" {
		return nil, nil
	}
	return result, nil
}

// findViaSearchAndScrape:
// Step 1: DuckDuckGo search to find LinkedIn profile URL.
// Step 2: Scrape LinkedIn profile directly with Chromium stealth for photo + experience.
func (c *LinkedInPersonClient) findViaSearchAndScrape(ctx context.Context, personName, personRole, companyName, stockCode string) (*LinkedInPersonResult, error) {
	// Ensure Chromium is available (will be lazily initialized per-request with recovery)
	if _, err := c.getChromClient(); err != nil {
		return nil, fmt.Errorf("chromium not available: %w", err)
	}

	searchCompany := extractCoreCompanyName(strings.ToLower(companyName))
	if searchCompany == "" {
		searchCompany = companyName
	}
	nameParts := strings.Fields(strings.ToLower(personName))

	// Strategy A: Search with quoted company name — best case, DDG finds exact match.
	query := fmt.Sprintf("site:linkedin.com/in \"%s\" \"%s\"", personName, searchCompany)
	candidates := c.searchDDGForLinkedIn(ctx, nil, query, nameParts)

	if len(candidates) > 0 {
		result := c.scrapeAndVerifyCandidate(ctx, nil, candidates[0], personName, companyName, stockCode, false)
		if result != nil {
			return result, nil
		}
	}

	// Strategy B: Search without site: operator — DDG's site: is too restrictive
	// with additional terms. Using "linkedin.com/in" as a text term works better.
	// queryHadCompany=true because the search query includes the company name,
	// so DDG returning a result implies relevance to that company.
	roleTerms := simplifyRole(personRole)
	query = fmt.Sprintf("linkedin.com/in \"%s\" %s %s", personName, searchCompany, roleTerms)
	candidates = c.searchDDGForLinkedIn(ctx, nil, query, nameParts)

	// Scrape top candidates (limit to 2 to conserve LinkedIn rate limit budget)
	limit := 2
	if len(candidates) < limit {
		limit = len(candidates)
	}
	for i := 0; i < limit; i++ {
		result := c.scrapeAndVerifyCandidate(ctx, nil, candidates[i], personName, companyName, stockCode, true)
		if result != nil {
			return result, nil
		}
	}

	// Strategy C: Name-only search with site: — last resort for prominent executives.
	// Only try first candidate to minimize scraping.
	query = fmt.Sprintf("site:linkedin.com/in \"%s\"", personName)
	candidates = c.searchDDGForLinkedIn(ctx, nil, query, nameParts)

	if len(candidates) > 0 {
		result := c.scrapeAndVerifyCandidate(ctx, nil, candidates[0], personName, companyName, stockCode, false)
		if result != nil {
			return result, nil
		}
	}

	// Strategy D: Direct URL probing with honorific slug patterns.
	// Only applies when the original (pre-cleaned) name has an honorific prefix like "Dr",
	// or when the input name itself suggests a title (e.g. "Dr Andrew Forrest" → "drandrewforrest").
	// This avoids false positives from probing "dr" + random names.
	slugs := generateLinkedInSlugs(personName)
	for _, slug := range slugs {
		probeURL := "https://www.linkedin.com/in/" + slug
		candidate := ddgCandidate{profileURL: probeURL}
		result := c.scrapeAndVerifyCandidate(ctx, nil, candidate, personName, companyName, stockCode, false)
		if result != nil {
			return result, nil
		}

		// If scrape failed (likely 999), verify the slug actually exists on LinkedIn
		// by searching DDG for the exact LinkedIn URL. This prevents false positives
		// from probing non-existent profiles.
		verifyQuery := fmt.Sprintf("site:linkedin.com/in/%s", slug)
		verifyURL := fmt.Sprintf("https://duckduckgo.com/?q=%s", url.QueryEscape(verifyQuery))
		c.rateLimit()
		client, err := c.getChromClient()
		if err != nil {
			continue
		}
		verifyDoc, _, verifyErr := client.FetchHTML(ctx, verifyURL)
		if verifyErr != nil {
			c.resetChromClient()
			continue
		}
		// Check if DDG found the exact LinkedIn profile URL
		pageText := strings.ToLower(verifyDoc.Text())
		if !strings.Contains(pageText, "linkedin.com/in/"+slug) {
			continue // Profile doesn't exist
		}

		// Profile exists on LinkedIn — now verify employment via company search
		titledName := slugPrefixToName(slug, personName)
		if titledName != "" {
			empQuery := fmt.Sprintf("\"%s\" \"%s\"", titledName, searchCompany)
			empURL := fmt.Sprintf("https://duckduckgo.com/?q=%s", url.QueryEscape(empQuery))
			c.rateLimit()
			client, err = c.getChromClient()
			if err != nil {
				continue
			}
			empDoc, _, empErr := client.FetchHTML(ctx, empURL)
			if empErr != nil {
				c.resetChromClient()
				continue
			}
			empText := strings.ToLower(empDoc.Text())
			if strings.Contains(empText, strings.ToLower(titledName)) && containsCompanyName(empText, strings.ToLower(searchCompany)) {
				return &LinkedInPersonResult{
					Name:            personName,
					ProfileURL:      probeURL,
					CompanyVerified: true,
					MatchedCompany:  companyName,
					Source:          "slug_probe",
				}, nil
			}
		}
	}

	return nil, nil
}

// slugPrefixToName reconstructs "Dr Andrew Forrest" from slug "drandrewforrest" and name "Andrew Forrest".
func slugPrefixToName(slug, originalName string) string {
	nameLower := strings.ToLower(originalName)
	var parts []string
	for _, word := range strings.Fields(nameLower) {
		var cleaned strings.Builder
		for _, r := range word {
			if r >= 'a' && r <= 'z' {
				cleaned.WriteRune(r)
			}
		}
		if cleaned.Len() > 0 {
			parts = append(parts, cleaned.String())
		}
	}
	concat := strings.Join(parts, "")

	for _, prefix := range []string{"dr", "professor", "prof"} {
		if slug == prefix+concat || slug == prefix+"-"+strings.Join(parts, "-") {
			titleCase := strings.ToUpper(prefix[:1]) + prefix[1:]
			return titleCase + " " + originalName
		}
	}
	return ""
}

// simplifyRole extracts a short search term from a role like "Chief Executive Officer" → "CEO".
func simplifyRole(role string) string {
	role = strings.TrimSpace(strings.ToLower(role))
	abbrevs := map[string]string{
		"chief executive officer":   "CEO",
		"managing director":         "managing director",
		"chief financial officer":   "CFO",
		"chief operating officer":   "COO",
		"chief technology officer":  "CTO",
		"chairman":                  "chairman",
		"executive chairman":        "chairman",
		"non-executive chairman":    "chairman",
		"founder":                   "founder",
	}
	for full, abbr := range abbrevs {
		if strings.Contains(role, full) {
			return abbr
		}
	}
	if role != "" {
		return role
	}
	return ""
}

func (c *LinkedInPersonClient) searchOnlyResult(personName string, candidate ddgCandidate, preResult *LinkedInPersonResult) *LinkedInPersonResult {
	return &LinkedInPersonResult{
		Name:            personName,
		ProfileURL:      candidate.profileURL,
		Headline:        candidate.searchText,
		ExperienceTitle: candidate.searchText,
		CompanyVerified: true,
		MatchedCompany:  preResult.MatchedCompany,
		Source:          "search",
	}
}

// ddgCandidate represents a LinkedIn profile found via DDG search.
type ddgCandidate struct {
	profileURL string
	searchText string // combined link text + snippet
}

// searchDDGForLinkedIn searches DDG and returns LinkedIn /in/ profile candidates.
// Automatically recovers from Chromium crashes by creating a new browser instance.
func (c *LinkedInPersonClient) searchDDGForLinkedIn(ctx context.Context, _ *stealthhttp.Client, query string, nameParts []string) []ddgCandidate {
	ddgURL := fmt.Sprintf("https://duckduckgo.com/?q=%s", url.QueryEscape(query))
	c.rateLimit()

	client, err := c.getChromClient()
	if err != nil {
		return nil
	}

	searchDoc, _, searchErr := client.FetchHTML(ctx, ddgURL)
	if searchErr != nil {
		// Chrome may have crashed — reset and retry once
		c.resetChromClient()
		client, err = c.getChromClient()
		if err != nil {
			return nil
		}
		searchDoc, _, searchErr = client.FetchHTML(ctx, ddgURL)
		if searchErr != nil {
			return nil
		}
	}

	// Collect all LinkedIn /in/ links with their text.
	// DDG renders two <a> tags per result: URL breadcrumb + title.
	type linkedInLink struct {
		href    string
		texts   []string
		snippet string
	}
	var liLinks []linkedInLink
	liLinkIndex := map[string]int{}

	searchDoc.Find("a").Each(func(_ int, s *goquery.Selection) {
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
		}
	}
	return results
}

// scrapeAndVerifyCandidate scrapes a LinkedIn profile and verifies employment.
// Returns nil if verification fails or scraping fails without pre-verification.
// When queryHadCompany is true (Strategy B), DDG returning this result for a query
// containing the company name is treated as weak employment verification if scraping fails.
func (c *LinkedInPersonClient) scrapeAndVerifyCandidate(ctx context.Context, _ *stealthhttp.Client, candidate ddgCandidate, personName, companyName, stockCode string, queryHadCompany bool) *LinkedInPersonResult {
	// Check if search snippet already confirms employment
	preResult := &LinkedInPersonResult{
		ExperienceTitle: candidate.searchText,
		Headline:        candidate.searchText,
	}
	preVerified := verifyEmployment(preResult, companyName, stockCode)

	// Scrape LinkedIn profile directly (with Chrome crash recovery)
	c.rateLimit()
	client, err := c.getChromClient()
	if err != nil {
		if preVerified {
			return c.searchOnlyResult(personName, candidate, preResult)
		}
		return nil
	}
	profileDoc, _, profileErr := client.FetchHTML(ctx, candidate.profileURL)
	if profileErr != nil {
		// Try resetting Chrome once
		c.resetChromClient()
		client, err = c.getChromClient()
		if err == nil {
			profileDoc, _, profileErr = client.FetchHTML(ctx, candidate.profileURL)
		}
	}
	if profileErr != nil {
		// LinkedIn returned an error (e.g., 999) — use search-only data if pre-verified
		// or if the search query itself contained the company name (Strategy B).
		if preVerified {
			return &LinkedInPersonResult{
				Name:            personName,
				ProfileURL:      candidate.profileURL,
				Headline:        candidate.searchText,
				ExperienceTitle: candidate.searchText,
				CompanyVerified: true,
				MatchedCompany:  preResult.MatchedCompany,
				Source:          "search",
			}
		}
		if queryHadCompany {
			// DDG returned this profile for a query containing the company name.
			// Trust DDG's relevance ranking as weak employment verification.
			return &LinkedInPersonResult{
				Name:            personName,
				ProfileURL:      candidate.profileURL,
				Headline:        candidate.searchText,
				ExperienceTitle: candidate.searchText,
				CompanyVerified: true,
				MatchedCompany:  companyName,
				Source:          "search",
			}
		}
		return nil
	}

	// Extract profile data
	result := extractLinkedInPersonData(profileDoc, candidate.profileURL)
	if result == nil {
		if preVerified {
			return &LinkedInPersonResult{
				Name:            personName,
				ProfileURL:      candidate.profileURL,
				Headline:        candidate.searchText,
				ExperienceTitle: candidate.searchText,
				CompanyVerified: true,
				MatchedCompany:  preResult.MatchedCompany,
				Source:          "search",
			}
		}
		return nil
	}

	result.Source = "linkedin_direct"
	result.CompanyVerified = verifyEmployment(result, companyName, stockCode)

	if !result.CompanyVerified && preVerified {
		result.CompanyVerified = true
		result.MatchedCompany = preResult.MatchedCompany
		result.Source = "search"
	}

	if !result.CompanyVerified {
		return nil
	}

	return result
}

// extractLinkedInPersonData extracts person data from a LinkedIn profile page.
func extractLinkedInPersonData(doc *goquery.Document, profileURL string) *LinkedInPersonResult {
	if doc == nil {
		return nil
	}

	result := &LinkedInPersonResult{
		ProfileURL: profileURL,
	}

	// Extract name
	for _, sel := range []string{
		"h1.top-card-layout__title",
		"h1.text-heading-xlarge",
		".pv-top-card--list .text-heading-xlarge",
		".top-card__title",
		"h1",
	} {
		name := strings.TrimSpace(doc.Find(sel).First().Text())
		if name != "" && len(name) < 100 {
			result.Name = name
			break
		}
	}

	// Extract headline
	for _, sel := range []string{
		".top-card-layout__headline",
		"div.text-body-medium",
		".top-card__subline",
	} {
		headline := strings.TrimSpace(doc.Find(sel).First().Text())
		if headline != "" && len(headline) < 300 {
			result.Headline = headline
			break
		}
	}

	// Extract profile photo
	result.ImageURL = ExtractLinkedInProfilePhoto(doc)

	// Extract experience for verification
	extractLinkedInExperience(doc, result)

	return result
}

// ExtractLinkedInProfilePhoto extracts the profile photo URL.
func ExtractLinkedInProfilePhoto(doc *goquery.Document) string {
	for _, sel := range []string{
		"img.top-card-layout__entity-image",
		"img.top-card__profile-image",
		"img.pv-top-card-profile-picture__image",
		"img.profile-photo-edit__preview",
		".pv-top-card--photo img",
		".top-card-layout__entity-image-container img",
	} {
		var imgURL string
		doc.Find(sel).EachWithBreak(func(_ int, s *goquery.Selection) bool {
			src, exists := s.Attr("src")
			if !exists {
				src, exists = s.Attr("data-delayed-url")
			}
			if exists && src != "" && !strings.Contains(src, "ghost-person") && !strings.HasPrefix(src, "data:") {
				imgURL = src
				return false
			}
			return true
		})
		if imgURL != "" {
			return imgURL
		}
	}

	// Fallback: og:image
	ogImage, _ := doc.Find("meta[property='og:image']").Attr("content")
	if ogImage != "" && !strings.Contains(ogImage, "ghost-person") && !strings.Contains(ogImage, "company-logo") && !strings.Contains(ogImage, "favicon") && !strings.Contains(ogImage, "static.licdn.com") {
		return ogImage
	}
	return ""
}

// extractLinkedInExperience parses experience for employment verification.
func extractLinkedInExperience(doc *goquery.Document, result *LinkedInPersonResult) {
	var texts []string
	for _, sel := range []string{
		"#experience ~ .pvs-list__outer-container",
		"section.experience",
		"#experience",
		".experience__list",
	} {
		doc.Find(sel).Each(func(_ int, s *goquery.Selection) {
			text := strings.TrimSpace(s.Text())
			if text != "" {
				texts = append(texts, text)
			}
		})
	}
	if result.Headline != "" {
		texts = append(texts, result.Headline)
	}
	if len(texts) > 0 {
		result.ExperienceTitle = strings.Join(texts, " | ")
		if len(result.ExperienceTitle) > 2000 {
			result.ExperienceTitle = result.ExperienceTitle[:2000]
		}
	}
}

// verifyEmployment checks if LinkedIn data matches the target company.
func verifyEmployment(result *LinkedInPersonResult, companyName, stockCode string) bool {
	if result == nil {
		return false
	}

	allText := strings.ToLower(result.ExperienceTitle + " " + result.Headline + " " + result.Name)
	companyLower := strings.ToLower(strings.TrimSpace(companyName))
	if companyLower == "" {
		return false
	}

	if containsCompanyName(allText, companyLower) {
		result.MatchedCompany = companyName
		return true
	}

	stockLower := strings.ToLower(strings.TrimSpace(stockCode))
	if stockLower != "" && len(stockLower) >= 2 {
		if containsWord(allText, stockLower) {
			result.MatchedCompany = stockCode
			return true
		}
	}

	coreName := extractCoreCompanyName(companyLower)
	if coreName != "" && coreName != companyLower {
		if containsCompanyName(allText, coreName) {
			result.MatchedCompany = coreName
			return true
		}
	}
	return false
}

func containsCompanyName(text, companyName string) bool {
	words := strings.Fields(companyName)
	if len(words) >= 2 && strings.Contains(text, companyName) {
		return true
	}
	significantWords := filterInsignificantWords(words)
	if len(significantWords) >= 2 {
		twoWordPrefix := strings.Join(significantWords[:2], " ")
		if strings.Contains(text, twoWordPrefix) {
			return true
		}
	}
	if len(significantWords) == 1 && len(significantWords[0]) >= 3 {
		return containsWord(text, significantWords[0])
	}
	if len(words) == 1 && len(companyName) >= 3 {
		return containsWord(text, companyName)
	}
	return false
}

func containsWord(text, word string) bool {
	idx := strings.Index(text, word)
	for idx >= 0 {
		leftOK := idx == 0 || !isAlphanumeric(text[idx-1])
		rightIdx := idx + len(word)
		rightOK := rightIdx >= len(text) || !isAlphanumeric(text[rightIdx])
		if leftOK && rightOK {
			return true
		}
		nextIdx := strings.Index(text[idx+1:], word)
		if nextIdx < 0 {
			break
		}
		idx = idx + 1 + nextIdx
	}
	return false
}

func isAlphanumeric(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9')
}

func extractCoreCompanyName(name string) string {
	suffixes := []string{
		" limited", " ltd", " pty ltd", " pty", " inc", " inc.",
		" corp", " corporation", " group limited", " group ltd",
		" holdings limited", " holdings ltd", " holdings",
		" international", " australia", " group",
	}
	cleaned := name
	for _, suffix := range suffixes {
		cleaned = strings.TrimSuffix(cleaned, suffix)
	}
	cleaned = strings.TrimSpace(cleaned)
	if cleaned == "" {
		return name
	}
	return cleaned
}

func filterInsignificantWords(words []string) []string {
	insignificant := map[string]bool{
		"limited": true, "ltd": true, "pty": true, "inc": true,
		"corp": true, "corporation": true, "group": true,
		"holdings": true, "international": true, "the": true,
		"of": true, "and": true, "australia": true, "nz": true,
	}
	var result []string
	for _, w := range words {
		if !insignificant[w] {
			result = append(result, w)
		}
	}
	return result
}

func isLinkedInProfileURL(rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	return (u.Host == "linkedin.com" || u.Host == "www.linkedin.com" ||
		strings.HasSuffix(u.Host, ".linkedin.com")) &&
		strings.HasPrefix(u.Path, "/in/")
}

// IsPlaceholderName returns true if the name is a generic placeholder or not a real person name.
// Exported for use by the backfill pipeline to skip enrichment for non-person entries.
func IsPlaceholderName(name string) bool {
	name = strings.TrimSpace(name)
	if name == "" {
		return true
	}

	nameLower := strings.ToLower(name)

	// Exact placeholder names
	for _, placeholder := range []string{
		"john doe", "jane doe", "john smith", "jane smith",
		"n/a", "tbd", "unknown", "not available", "vacant",
	} {
		if nameLower == placeholder {
			return true
		}
	}

	// Clean the name to get alpha-only words
	var words []string
	for _, word := range strings.Fields(nameLower) {
		var cleaned strings.Builder
		for _, r := range word {
			if r >= 'a' && r <= 'z' {
				cleaned.WriteRune(r)
			}
		}
		if cleaned.Len() > 0 {
			words = append(words, cleaned.String())
		}
	}

	// Must have at least 2 alpha words to be a person name
	if len(words) < 2 {
		return true
	}

	// Detect non-person phrases (slogans, company names, section headers)
	// These are common in poorly scraped Yahoo Finance data.
	nonPersonPhrases := []string{
		"ready to", "creating impact", "our commitment", "our mission",
		"our vision", "our values", "our team", "our people",
		"company overview", "about us", "learn more",
	}
	for _, phrase := range nonPersonPhrases {
		if strings.Contains(nameLower, phrase) {
			return true
		}
	}

	// If name ends with common company suffixes, it's likely a company name
	companySuffixes := []string{"group", "limited", "ltd", "inc", "pty", "corp", "corporation", "holdings"}
	lastWord := words[len(words)-1]
	for _, suffix := range companySuffixes {
		if lastWord == suffix {
			return true
		}
	}

	return false
}

// generateLinkedInSlugs constructs plausible LinkedIn URL slugs for a person
// whose name actually contains a "Dr" title. Only generates slugs when the
// person is known to be a doctor — prevents false positives from blindly
// prepending "dr" to every name.
func generateLinkedInSlugs(name string) []string {
	if IsPlaceholderName(name) {
		return nil
	}

	nameLower := strings.ToLower(strings.TrimSpace(name))

	// Only generate "dr" slugs if the name actually starts with a doctor title
	hasDrTitle := false
	drPrefixes := []string{"dr.", "dr ", "dr."}
	for _, prefix := range drPrefixes {
		if strings.HasPrefix(nameLower, prefix) {
			hasDrTitle = true
			break
		}
	}
	if !hasDrTitle {
		return nil
	}

	// Strip the "Dr"/"Dr." prefix and extract the actual name parts
	stripped := nameLower
	for _, prefix := range drPrefixes {
		stripped = strings.TrimPrefix(stripped, prefix)
	}
	stripped = strings.TrimSpace(stripped)

	// Clean to alpha-only parts
	var parts []string
	for _, word := range strings.Fields(stripped) {
		var cleaned strings.Builder
		for _, r := range word {
			if r >= 'a' && r <= 'z' {
				cleaned.WriteRune(r)
			}
		}
		if cleaned.Len() > 0 {
			parts = append(parts, cleaned.String())
		}
	}
	if len(parts) < 2 {
		return nil
	}

	// Also strip qualification suffixes before generating slug
	// (e.g., "Ph.D.", "M.A.I.C.D." etc are cleaned to alpha parts but shouldn't be in slug)
	cleanedName := cleanPersonNameForSearch(name)
	cleanedLower := strings.ToLower(cleanedName)
	// Re-strip Dr prefix from cleaned name
	for _, prefix := range drPrefixes {
		cleanedLower = strings.TrimPrefix(cleanedLower, prefix)
	}
	cleanedLower = strings.TrimSpace(cleanedLower)
	var cleanParts []string
	for _, word := range strings.Fields(cleanedLower) {
		var cleaned strings.Builder
		for _, r := range word {
			if r >= 'a' && r <= 'z' {
				cleaned.WriteRune(r)
			}
		}
		if cleaned.Len() > 0 {
			cleanParts = append(cleanParts, cleaned.String())
		}
	}
	if len(cleanParts) >= 2 {
		parts = cleanParts // Use cleaned name parts (without qualifications)
	}

	concat := strings.Join(parts, "")
	hyphen := strings.Join(parts, "-")

	var slugs []string
	seen := map[string]bool{}
	add := func(s string) {
		if s != "" && !seen[s] {
			seen[s] = true
			slugs = append(slugs, s)
		}
	}

	add("dr" + concat)       // drandrewforrest
	add("dr-" + hyphen)      // dr-andrew-forrest

	return slugs
}

func personNameToLinkedInProfileSlug(name string) string {
	name = cleanPersonNameForSearch(name)
	if name == "" {
		return ""
	}
	name = strings.ToLower(name)
	var parts []string
	for _, word := range strings.Fields(name) {
		var cleaned strings.Builder
		for _, r := range word {
			if r >= 'a' && r <= 'z' {
				cleaned.WriteRune(r)
			}
		}
		if cleaned.Len() > 0 {
			parts = append(parts, cleaned.String())
		}
	}
	if len(parts) == 0 {
		return ""
	}
	return strings.Join(parts, "-")
}
