package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/url"
	"os"
	"strings"
	"time"

	"cloud.google.com/go/storage"
	"github.com/PuerkitoBio/goquery"
	"github.com/castlemilk/shorted.com.au/services/pkg/enrichment"
	"github.com/skunkworq/stealth/brws/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/pkg/stealthhttp"
)


// runImageBackfill fetches LinkedIn profile photos for people who have LinkedIn URLs
// but no images.
func (p *enrichmentProcessor) runImageBackfill(ctx context.Context, limit int, afterStockCode string) error {
	p.logger.Infof("Starting image backfill (limit: %d, after: %q)", limit, afterStockCode)

	stocks, err := p.store.GetStocksForImageBackfill(limit, afterStockCode)
	if err != nil {
		return fmt.Errorf("failed to query stocks for image backfill: %w", err)
	}

	if len(stocks) == 0 {
		p.logger.Infof("No stocks need image backfill")
		return nil
	}

	p.logger.Infof("Found %d stocks needing image backfill", len(stocks))

	successCount := 0
	failCount := 0
	photoCount := 0

	for i, stock := range stocks {
		p.logger.Infof("[%d/%d] Processing %s (%s)", i+1, len(stocks), stock.StockCode, stock.CompanyName)

		photos, err := p.backfillStockImages(ctx, stock)
		if err != nil {
			p.logger.Errorf("Failed to backfill images for %s: %v", stock.StockCode, err)
			failCount++
			continue
		}

		successCount++
		photoCount += photos
		p.logger.Infof("[%d/%d] Got %d photos for %s", i+1, len(stocks), photos, stock.StockCode)
	}

	p.logger.Infof("Image backfill complete: %d stocks processed, %d failed, %d photos fetched", successCount, failCount, photoCount)
	return nil
}

// backfillStockImages fetches profile photos for people in a single stock.
func (p *enrichmentProcessor) backfillStockImages(ctx context.Context, stock enrichment.StockPeopleData) (int, error) {
	var people []backfillPerson
	if err := json.Unmarshal(stock.KeyPeople, &people); err != nil {
		return 0, fmt.Errorf("failed to parse key_people: %w", err)
	}

	if len(people) == 0 {
		return 0, nil
	}

	photosFound := 0
	changed := false
	seenURLs := make(map[string]string) // LinkedIn URL → GCS URL (for dedup)

	maxPeople := min(3, len(people))
	for i := 0; i < maxPeople; i++ {
		person := &people[i]

		if person.LinkedInURL == "" || person.ImageGCSURL != "" {
			continue
		}

		// Skip duplicate LinkedIn URLs
		if gcsURL, seen := seenURLs[person.LinkedInURL]; seen {
			if gcsURL != "" {
				person.ImageGCSURL = gcsURL
				changed = true
			}
			continue
		}
		if person.Name == "" || enrichment.IsPlaceholderName(person.Name) {
			continue
		}

		p.logger.Infof("  Fetching photo for %s from %s", person.Name, person.LinkedInURL)

		var photoURL string
		var scrapeErr error

		// Use authenticated client if available, otherwise Google Image Search
		if p.linkedInPhotoClient != nil {
			photoURL, scrapeErr = p.linkedInPhotoClient.FetchProfilePhotoViaAPI(ctx, person.LinkedInURL)
		} else if p.stealthClient != nil {
			photoURL, scrapeErr = p.scrapeLinkedInPhotoStealth(ctx, person.LinkedInURL, person.Name, stock.CompanyName)
		} else {
			scrapeErr = fmt.Errorf("no scraping client available")
		}

		if scrapeErr != nil {
			p.logger.Warnf("  Scrape failed for %s: %v", person.Name, scrapeErr)
			seenURLs[person.LinkedInURL] = ""
			continue
		}

		if photoURL == "" {
			p.logger.Infof("  No photo found for %s", person.Name)
			seenURLs[person.LinkedInURL] = ""
			continue
		}

		p.logger.Infof("  Found photo for %s: %s", person.Name, truncateURL(photoURL, 80))
		person.ImageURL = photoURL
		person.SourceURL = person.LinkedInURL
		changed = true

		// Download and upload to GCS
		if p.personImageProcessor != nil {
			if p.linkedInPhotoClient != nil {
				// Authenticated: download via browser canvas, upload bytes directly
				imgBytes, contentType, dlErr := p.linkedInPhotoClient.DownloadImageBytes(ctx, photoURL)
				if dlErr != nil {
					p.logger.Warnf("  Browser download failed for %s: %v", person.Name, dlErr)
					seenURLs[person.LinkedInURL] = ""
				} else {
					gcsURL, uploadErr := p.personImageProcessor.UploadFromBytes(ctx, imgBytes, contentType, stock.StockCode, person.Name)
					if uploadErr != nil {
						p.logger.Warnf("  GCS upload failed for %s: %v", person.Name, uploadErr)
						seenURLs[person.LinkedInURL] = ""
					} else {
						person.ImageGCSURL = gcsURL
						photosFound++
						seenURLs[person.LinkedInURL] = gcsURL
						p.logger.Infof("  Uploaded to GCS: %s", gcsURL)
					}
				}
			} else {
				// Stealth: photo URL is publicly accessible, use plain HTTP download
				gcsURL, uploadErr := p.personImageProcessor.ProcessAndUpload(ctx, photoURL, stock.StockCode, person.Name)
				if uploadErr != nil {
					p.logger.Warnf("  GCS upload failed for %s: %v", person.Name, uploadErr)
					seenURLs[person.LinkedInURL] = ""
				} else {
					person.ImageGCSURL = gcsURL
					photosFound++
					seenURLs[person.LinkedInURL] = gcsURL
					p.logger.Infof("  Uploaded to GCS: %s", gcsURL)
				}
			}
		} else {
			seenURLs[person.LinkedInURL] = ""
			photosFound++
		}
	}

	if !changed {
		return 0, nil
	}

	updatedJSON, err := json.Marshal(people)
	if err != nil {
		return 0, fmt.Errorf("failed to marshal updated key_people: %w", err)
	}
	if err := p.store.UpdateKeyPeopleEnriched(stock.StockCode, updatedJSON); err != nil {
		return 0, fmt.Errorf("failed to update key_people: %w", err)
	}

	return photosFound, nil
}

// scrapeLinkedInPhotoStealth fetches a LinkedIn profile photo.
// Strategy 1: Direct LinkedIn fetch via stealth Chromium (returns body even on 999).
// Strategy 2: Google Image Search (Google caches LinkedIn CDN og:image URLs).
func (p *enrichmentProcessor) scrapeLinkedInPhotoStealth(ctx context.Context, profileURL, personName, companyName string) (string, error) {
	if p.stealthClient == nil {
		return "", fmt.Errorf("stealth client not initialized")
	}

	// Strategy 1: Direct LinkedIn fetch via stealth Chromium.
	p.rateLimit()
	resp, err := p.stealthClient.Do(ctx, &engine.Request{
		Method:          "GET",
		URL:             profileURL,
		FollowRedirects: true,
		MaxRedirects:    5,
		Timeout:         30 * time.Second,
	})
	if err != nil {
		p.logger.Warnf("    Direct fetch failed: %v", err)
	} else if len(resp.Body) > 0 {
		doc, parseErr := goquery.NewDocumentFromReader(bytes.NewReader(resp.Body))
		if parseErr == nil {
			if photoURL := enrichment.ExtractLinkedInProfilePhoto(doc); photoURL != "" {
				return photoURL, nil
			}
		}
		if photoURL := extractLinkedInCDNPhotoBroad(string(resp.Body)); photoURL != "" {
			return photoURL, nil
		}
	}

	// Strategy 2: Google Image Search
	slug := extractLinkedInSlug(profileURL)
	queries := buildSearchQueries(slug, personName, companyName)

	for i, query := range queries {
		p.rateLimit()

		searchURL := fmt.Sprintf("https://www.google.com/search?q=%s&udm=2", url.QueryEscape(query))

		doc, _, err := p.stealthClient.FetchHTML(ctx, searchURL)
		if err != nil {
			status := stealthhttp.StatusError(err)
			if status == 429 {
				p.google429Count++
				// Exponential backoff: 5min after first 429, longer if repeated
				backoff := time.Duration(5*p.google429Count) * time.Minute
				if backoff > 15*time.Minute {
					backoff = 15 * time.Minute
				}
				p.logger.Warnf("    Google 429 (#%d) — cooling off %s", p.google429Count, backoff.Round(time.Second))
				select {
				case <-time.After(backoff):
				case <-ctx.Done():
					return "", ctx.Err()
				}
				return "", fmt.Errorf("google rate limited")
			}
			p.logger.Warnf("    Google search %d/%d failed: %v", i+1, len(queries), err)
			continue
		}
		// Reset 429 counter on success
		p.google429Count = 0

		if photoURL := extractLinkedInCDNPhoto(doc); photoURL != "" {
			return photoURL, nil
		}
	}

	return "", fmt.Errorf("no photo found (%d strategies tried)", 1+len(queries))
}

// rateLimit waits 20-35s between Google searches (slow and random to avoid 429).
func (p *enrichmentProcessor) rateLimit() {
	if !p.lastScrape.IsZero() {
		minDelay := 20*time.Second + time.Duration(rand.Intn(15000))*time.Millisecond
		if elapsed := time.Since(p.lastScrape); elapsed < minDelay {
			time.Sleep(minDelay - elapsed)
		}
	}
	p.lastScrape = time.Now()
}

// buildSearchQueries returns up to 3 Google Image search queries to try, ordered by specificity.
func buildSearchQueries(slug, personName, companyName string) []string {
	var queries []string

	// 1. Slug-based (most specific — matches LinkedIn URL directly)
	if slug != "" {
		queries = append(queries, fmt.Sprintf(`"%s" site:linkedin.com`, slug))
	}

	// 2. Real name + linkedin (catches name mismatches with slug)
	cleanName := cleanPersonName(personName)
	if cleanName != "" && cleanName != slug {
		queries = append(queries, fmt.Sprintf(`"%s" site:linkedin.com`, cleanName))
	}

	// 3. Real name + company (no site: restriction — catches other indexed sources)
	if cleanName != "" && companyName != "" {
		queries = append(queries, fmt.Sprintf(`"%s" "%s" linkedin`, cleanName, companyName))
	}

	return queries
}

// cleanPersonName strips titles and suffixes from a person's name.
// "Dr. Guido Arnout" → "guido arnout", "Mr John Smith AM" → "john smith"
func cleanPersonName(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))

	// Strip common prefixes
	for _, prefix := range []string{"dr. ", "dr ", "mr. ", "mr ", "mrs. ", "mrs ", "ms. ", "ms ", "prof. ", "prof "} {
		name = strings.TrimPrefix(name, prefix)
	}

	// Strip common suffixes
	for _, suffix := range []string{" am", " ao", " obe", " phd", " mba", " cfa", " ca"} {
		name = strings.TrimSuffix(name, suffix)
	}

	return strings.TrimSpace(name)
}

// extractLinkedInCDNPhoto extracts a LinkedIn profile photo CDN URL from search engine HTML.
func extractLinkedInCDNPhoto(doc *goquery.Document) string {
	html, err := doc.Html()
	if err != nil {
		return ""
	}
	return extractLinkedInCDNPhotoBroad(html)
}

// extractLinkedInCDNPhotoBroad searches raw HTML for LinkedIn CDN profile photo URLs.
// Works with Google, DuckDuckGo, and other search engines that embed CDN URLs.
func extractLinkedInCDNPhotoBroad(html string) string {
	// Split on common delimiters (quotes, whitespace, commas)
	for _, sep := range []string{`"`, `'`, `,`, ` `} {
		for _, part := range strings.Split(html, sep) {
			decoded := strings.ReplaceAll(part, `\u0026`, "&")
			decoded = strings.ReplaceAll(decoded, `\u003d`, "=")
			decoded = strings.ReplaceAll(decoded, `&amp;`, "&")
			// URL-encoded versions (DDG sometimes double-encodes)
			decoded = strings.ReplaceAll(decoded, `%26`, "&")
			decoded = strings.ReplaceAll(decoded, `%3D`, "=")
			decoded = strings.ReplaceAll(decoded, `%3d`, "=")
			if strings.Contains(decoded, "media.licdn.com") &&
				strings.Contains(decoded, "profile-displayphoto") &&
				!strings.Contains(decoded, "ghost-person") {
				// Clean up: extract just the URL part
				if idx := strings.Index(decoded, "https://media.licdn.com"); idx >= 0 {
					decoded = decoded[idx:]
				} else if idx := strings.Index(decoded, "http://media.licdn.com"); idx >= 0 {
					decoded = decoded[idx:]
				}
				return decoded
			}
		}
	}
	return ""
}

// extractLinkedInSlug extracts and humanizes a LinkedIn profile slug.
// "https://au.linkedin.com/in/michael-kafrouni-8991885" → "michael kafrouni"
func extractLinkedInSlug(profileURL string) string {
	profileURL = strings.TrimRight(profileURL, "/")
	parts := strings.Split(profileURL, "/in/")
	if len(parts) < 2 {
		return ""
	}
	slug := parts[len(parts)-1]

	// Remove trailing numeric ID (e.g. "-8991885")
	dashParts := strings.Split(slug, "-")
	if len(dashParts) > 1 {
		last := dashParts[len(dashParts)-1]
		allDigits := true
		for _, c := range last {
			if c < '0' || c > '9' {
				allDigits = false
				break
			}
		}
		if allDigits && len(last) >= 3 {
			dashParts = dashParts[:len(dashParts)-1]
		}
	}

	return strings.Join(dashParts, " ")
}

func truncateURL(u string, maxLen int) string {
	if len(u) <= maxLen {
		return u
	}
	return u[:maxLen] + "..."
}

// runImageBackfillMain is the entry point for --backfill-images mode.
// Uses authenticated LinkedIn if LINKEDIN_EMAIL/PASSWORD are set, otherwise stealth Chromium.
func runImageBackfillMain(storeInstance enrichment.EnrichmentStore, logger *log.Logger, limit int, afterStockCode string, headless bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Hour)
	defer cancel()

	processor := &enrichmentProcessor{
		store:  storeInstance,
		logger: logger,
	}

	// Try authenticated LinkedIn first (if credentials provided)
	linkedInEmail := os.Getenv("LINKEDIN_EMAIL")
	linkedInPassword := os.Getenv("LINKEDIN_PASSWORD")
	if linkedInEmail != "" && linkedInPassword != "" {
		photoClient := enrichment.NewLinkedInPhotoClient(linkedInEmail, linkedInPassword, headless, logger)
		defer photoClient.Close()

		if err := photoClient.Login(ctx); err != nil {
			logger.Warnf("LinkedIn login failed: %v — falling back to stealth mode", err)
		} else {
			processor.linkedInPhotoClient = photoClient
			logger.Infof("Using authenticated LinkedIn session")
		}
	}

	// Fall back to Google Image Search via stealth Chromium
	if processor.linkedInPhotoClient == nil {
		chromClient, err := stealthhttp.NewChromium(stealthhttp.WithTimeout(30 * time.Second))
		if err != nil {
			logger.Errorf("Failed to create stealth Chromium client: %v", err)
			return
		}
		defer func() { _ = chromClient.Close() }()
		processor.stealthClient = chromClient
		logger.Infof("Using Google Image Search via stealth Chromium (no LinkedIn login)")
	}

	// Initialize GCS
	gcsBucket := os.Getenv("GCS_LOGO_BUCKET")
	if gcsBucket != "" {
		gcsClient, gcsErr := storage.NewClient(ctx)
		if gcsErr != nil {
			logger.Warnf("Failed to create GCS client: %v (continuing without image upload)", gcsErr)
		} else {
			processor.personImageProcessor = enrichment.NewPersonImageProcessor(gcsClient, gcsBucket)
			logger.Infof("Person image processor initialized (bucket: %s)", gcsBucket)
		}
	}

	if err := processor.runImageBackfill(ctx, limit, afterStockCode); err != nil {
		logger.Errorf("Image backfill failed: %v", err)
	}
}
