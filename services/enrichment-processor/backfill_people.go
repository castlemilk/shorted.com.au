package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/enrichment"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
)

// backfillPerson is the JSON shape stored in key_people JSONB
type backfillPerson struct {
	Name        string `json:"name"`
	Role        string `json:"role"`
	Bio         string `json:"bio"`
	ImageURL    string `json:"image_url,omitempty"`
	ImageGCSURL string `json:"image_gcs_url,omitempty"`
	LinkedInURL string `json:"linkedin_url,omitempty"`
	SourceURL   string `json:"source_url,omitempty"`
	SourceType  string `json:"source_type,omitempty"`
}

// runPeopleBackfill processes stocks that have key_people but haven't had
// person-level enrichment (images, Yahoo Finance cross-reference).
func (p *enrichmentProcessor) runPeopleBackfill(ctx context.Context, limit int) error {
	p.logger.Infof("Starting people backfill (limit: %d)", limit)

	stocks, err := p.store.GetStocksForPeopleEnrichment(limit)
	if err != nil {
		return fmt.Errorf("failed to query stocks for people enrichment: %w", err)
	}

	if len(stocks) == 0 {
		p.logger.Infof("No stocks need people enrichment")
		return nil
	}

	p.logger.Infof("Found %d stocks needing people enrichment", len(stocks))

	successCount := 0
	failCount := 0

	for i, stock := range stocks {
		p.logger.Infof("[%d/%d] Processing %s (%s)", i+1, len(stocks), stock.StockCode, stock.CompanyName)

		if err := p.backfillStockPeople(ctx, stock); err != nil {
			p.logger.Errorf("Failed to backfill %s: %v", stock.StockCode, err)
			failCount++
			continue
		}

		successCount++
		p.logger.Infof("[%d/%d] Successfully enriched people for %s", i+1, len(stocks), stock.StockCode)

		// Rate limit between stocks (Yahoo Finance + Wikipedia)
		time.Sleep(2 * time.Second)
	}

	p.logger.Infof("People backfill complete: %d succeeded, %d failed, %d total", successCount, failCount, len(stocks))
	return nil
}

// backfillStockPeople enriches key_people for a single stock using free sources
func (p *enrichmentProcessor) backfillStockPeople(ctx context.Context, stock enrichment.StockPeopleData) error {
	// Parse existing key_people from JSONB
	var people []backfillPerson
	if err := json.Unmarshal(stock.KeyPeople, &people); err != nil {
		return fmt.Errorf("failed to parse key_people: %w", err)
	}

	if len(people) == 0 {
		return nil
	}

	enrichedAny := false

	// Step 1: Fetch Yahoo Finance officers to cross-reference
	if p.yahooPeopleClient != nil {
		officers, err := p.yahooPeopleClient.GetCompanyOfficers(ctx, stock.StockCode)
		if err != nil {
			p.logger.Warnf("  Yahoo Finance officers failed for %s: %v", stock.StockCode, err)
		} else if len(officers) > 0 {
			p.logger.Infof("  Got %d officers from Yahoo Finance", len(officers))
			if mergeYahooOfficersBackfill(&people, officers) {
				enrichedAny = true
			}
		}
	}

	// Step 2: For top 3 people, try LinkedIn then Wikipedia for images
	maxPeople := min(3, len(people))
	for i := 0; i < maxPeople; i++ {
		person := &people[i]
		if person.Name == "" {
			continue
		}

		// Skip if already has image
		if person.ImageGCSURL != "" {
			p.logger.Infof("  Skipping %s (already has image)", person.Name)
			continue
		}

		// Skip placeholder/non-person names (e.g. "John Doe", "READY TO THRIVE?", "Alfabs Group")
		if enrichment.IsPlaceholderName(person.Name) {
			p.logger.Infof("  Skipping placeholder name: %s", person.Name)
			continue
		}

		p.logger.Infof("  Looking up image for: %s (%s)", person.Name, person.Role)

		// Source A: LinkedIn profile (verified employment at target company)
		if person.LinkedInURL == "" && p.linkedInPersonClient != nil {
			liResult, err := p.linkedInPersonClient.FindAndVerifyPerson(ctx, person.Name, person.Role, stock.CompanyName, stock.StockCode)
			if err != nil {
				p.logger.Warnf("  LinkedIn lookup failed for %s: %v", person.Name, err)
			} else if liResult != nil {
				person.LinkedInURL = liResult.ProfileURL
				person.SourceType = liResult.Source
				enrichedAny = true
				p.logger.Infof("  Found LinkedIn profile for %s: %s (source: %s, company: %s)",
					person.Name, liResult.ProfileURL, liResult.Source, liResult.MatchedCompany)
				if liResult.ImageURL != "" {
					person.ImageURL = liResult.ImageURL
					person.SourceURL = liResult.ProfileURL
					p.logger.Infof("  Found LinkedIn photo for %s: %s", person.Name, liResult.ImageURL)
				}
			}
		}

		// Source B: Wikipedia (good for well-known executives)
		if person.ImageURL == "" && p.wikipediaClient != nil {
			imageURL, pageURL, err := p.wikipediaClient.GetPersonImage(ctx, person.Name)
			if err != nil {
				p.logger.Warnf("  Wikipedia lookup failed for %s: %v", person.Name, err)
			} else if imageURL != "" {
				person.ImageURL = imageURL
				person.SourceURL = pageURL
				if person.SourceType == "" {
					person.SourceType = "wikipedia"
				}
				enrichedAny = true
			}
		}

		// Upload image to GCS
		if person.ImageURL != "" && person.ImageGCSURL == "" && p.personImageProcessor != nil {
			gcsURL, err := p.personImageProcessor.ProcessAndUpload(ctx, person.ImageURL, stock.StockCode, person.Name)
			if err != nil {
				p.logger.Warnf("  Image upload failed for %s: %v", person.Name, err)
			} else {
				person.ImageGCSURL = gcsURL
				enrichedAny = true
				p.logger.Infof("  Uploaded image for %s: %s", person.Name, gcsURL)
			}
		}
	}

	if !enrichedAny {
		p.logger.Infof("  No new enrichment data found for %s", stock.StockCode)
	}

	// Marshal updated people back to JSON
	updatedJSON, err := json.Marshal(people)
	if err != nil {
		return fmt.Errorf("failed to marshal updated key_people: %w", err)
	}

	// Update database
	if err := p.store.UpdateKeyPeopleEnriched(stock.StockCode, updatedJSON); err != nil {
		return fmt.Errorf("failed to update key_people: %w", err)
	}

	return nil
}

// mergeYahooOfficersBackfill cross-references Yahoo Finance officers with existing people.
// Returns true if any data was added/updated.
func mergeYahooOfficersBackfill(people *[]backfillPerson, officers []enrichment.YahooOfficer) bool {
	existingNames := make(map[string]int) // lowercase name → index
	for i, person := range *people {
		existingNames[normalizeNameForMatch(person.Name)] = i
	}

	changed := false
	for _, officer := range officers {
		key := normalizeNameForMatch(officer.Name)

		if idx, found := existingNames[key]; found {
			// Update role if empty
			p := &(*people)[idx]
			if p.Role == "" && officer.Title != "" {
				p.Role = officer.Title
				changed = true
			}
			if p.SourceType == "" {
				p.SourceType = "yahoo_finance"
				changed = true
			}
		} else if len(*people) < 10 {
			// Add new officer
			*people = append(*people, backfillPerson{
				Name:       officer.Name,
				Role:       officer.Title,
				SourceType: "yahoo_finance",
			})
			existingNames[key] = len(*people) - 1
			changed = true
		}
	}

	return changed
}

func normalizeNameForMatch(name string) string {
	return strings.ToLower(strings.TrimSpace(name))
}

// runPeopleBackfillMain is the entry point for --backfill-people mode
func runPeopleBackfillMain(processor *enrichmentProcessor, limit int, force bool, afterStockCode string) {
	logger := log.NewLogger()
	logger.SetLevel("debug")

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Hour)
	defer cancel()

	// Close LinkedIn Chromium client when done
	if processor.linkedInPersonClient != nil {
		defer processor.linkedInPersonClient.Close()
	}

	var err error
	if force {
		err = processor.runPeopleBackfillForce(ctx, limit, afterStockCode)
	} else {
		err = processor.runPeopleBackfill(ctx, limit)
	}
	if err != nil {
		logger.Errorf("People backfill failed: %v", err)
	}
}

// runPeopleBackfillForce re-processes stocks that already have key_people_enriched_at
// but are missing LinkedIn URLs. This adds LinkedIn data to existing enrichment.
// afterStockCode enables cursor pagination — pass "" for first page.
func (p *enrichmentProcessor) runPeopleBackfillForce(ctx context.Context, limit int, afterStockCode string) error {
	if afterStockCode != "" {
		p.logger.Infof("Starting people backfill FORCE mode (limit: %d, after: %s) — re-enriching with LinkedIn", limit, afterStockCode)
	} else {
		p.logger.Infof("Starting people backfill FORCE mode (limit: %d) — re-enriching with LinkedIn", limit)
	}

	stocks, err := p.store.GetStocksForPeopleReenrichment(limit, afterStockCode)
	if err != nil {
		return fmt.Errorf("failed to query stocks for people re-enrichment: %w", err)
	}

	if len(stocks) == 0 {
		p.logger.Infof("No stocks need LinkedIn re-enrichment")
		return nil
	}

	p.logger.Infof("Found %d stocks needing LinkedIn enrichment", len(stocks))

	successCount := 0
	failCount := 0

	for i, stock := range stocks {
		p.logger.Infof("[%d/%d] Processing %s (%s)", i+1, len(stocks), stock.StockCode, stock.CompanyName)

		if err := p.backfillStockPeople(ctx, stock); err != nil {
			p.logger.Errorf("Failed to backfill %s: %v", stock.StockCode, err)
			failCount++
			continue
		}

		successCount++
		p.logger.Infof("[%d/%d] Successfully enriched people for %s", i+1, len(stocks), stock.StockCode)

		// Rate limit between stocks
		time.Sleep(2 * time.Second)
	}

	p.logger.Infof("People backfill (force) complete: %d succeeded, %d failed, %d total", successCount, failCount, len(stocks))
	return nil
}
