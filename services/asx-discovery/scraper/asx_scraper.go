package scraper

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/playwright-community/playwright-go"
)

// ASXScraper handles headless browser interaction with ASX website
type ASXScraper struct {
	downloadDir string
	url         string
}

// NewASXScraper creates a new ASXScraper instance
func NewASXScraper(downloadDir string) *ASXScraper {
	return &ASXScraper{
		downloadDir: downloadDir,
		url:         "https://www.asx.com.au/markets/trade-our-cash-market/directory",
	}
}

// DownloadCSV downloads the ASX company directory CSV file
func (s *ASXScraper) DownloadCSV(ctx context.Context) (string, error) {
	// Create download directory if it doesn't exist
	if err := os.MkdirAll(s.downloadDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create download directory: %w", err)
	}

	absPath, err := filepath.Abs(s.downloadDir)
	if err != nil {
		return "", fmt.Errorf("failed to get absolute path: %w", err)
	}

	// Install Playwright driver if not already installed
	if err := playwright.Install(); err != nil {
		log.Printf("Warning: failed to install Playwright driver: %v (continuing anyway)", err)
	}

	// Initialize Playwright
	pw, err := playwright.Run()
	if err != nil {
		return "", fmt.Errorf("failed to start Playwright: %w", err)
	}
	defer pw.Stop()

	// Launch browser
	browser, err := pw.Chromium.Launch(playwright.BrowserTypeLaunchOptions{
		Headless: playwright.Bool(true),
		Args: []string{
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage",
		},
	})
	if err != nil {
		return "", fmt.Errorf("failed to launch browser: %w", err)
	}
	defer browser.Close()

	// Create browser context with download path
	context, err := browser.NewContext(playwright.BrowserNewContextOptions{
		AcceptDownloads: playwright.Bool(true),
	})
	if err != nil {
		return "", fmt.Errorf("failed to create browser context: %w", err)
	}
	defer context.Close()

	// Create page
	page, err := context.NewPage()
	if err != nil {
		return "", fmt.Errorf("failed to create page: %w", err)
	}
	defer page.Close()

	// Set up download listener
	downloadComplete := make(chan playwright.Download, 1)
	downloadFailed := make(chan error, 1)

	page.On("download", func(download playwright.Download) {
		log.Printf("Download started: %s", download.SuggestedFilename())
		select {
		case downloadComplete <- download:
		default:
		}
	})

	log.Printf("Navigating to %s", s.url)

	// Navigate to the page
	if _, err := page.Goto(s.url, playwright.PageGotoOptions{
		WaitUntil: playwright.WaitUntilStateNetworkidle,
		Timeout:   playwright.Float(30000), // 30 seconds
	}); err != nil {
		return "", fmt.Errorf("failed to navigate to page: %w", err)
	}

	// Wait for the download button to be visible
	selector := `a[aria-label="All ASX listed companies (CSV download)"]`
	if _, err := page.WaitForSelector(selector, playwright.PageWaitForSelectorOptions{
		Timeout: playwright.Float(30000),
	}); err != nil {
		return "", fmt.Errorf("download button not found: %w", err)
	}

	log.Printf("Found download button, checking for direct URL...")

	// Try to extract direct download URL if available
	href, err := page.GetAttribute(selector, "href")
	if err == nil && href != "" && !strings.HasPrefix(href, "javascript:") {
		// Make it absolute if relative
		if !strings.HasPrefix(href, "http") {
			href = "https://www.asx.com.au" + href
		}
		log.Printf("Found direct download URL: %s", href)
		return s.DownloadDirect(ctx, href)
	}

	log.Printf("Preparing to click download button...")

	// Wait for the button to be visible and enabled
	if _, err := page.WaitForSelector(selector, playwright.PageWaitForSelectorOptions{
		State:   playwright.WaitForSelectorStateVisible,
		Timeout: playwright.Float(30000),
	}); err != nil {
		return "", fmt.Errorf("download button not visible: %w", err)
	}

	// Scroll the button into view
	if _, err := page.Evaluate("document.querySelector(`a[aria-label=\"All ASX listed companies (CSV download)\"]`).scrollIntoView({behavior: 'smooth', block: 'center'});"); err != nil {
		log.Printf("Warning: failed to scroll button into view: %v", err)
	}

	// Wait a bit for any animations/JavaScript to settle
	time.Sleep(3 * time.Second)

	log.Printf("Clicking download button...")

	// Try clicking via JavaScript first (more reliable)
	if _, err := page.Evaluate("document.querySelector(`a[aria-label=\"All ASX listed companies (CSV download)\"]`).click();"); err == nil {
		log.Printf("Successfully clicked button via JavaScript")
	} else {
		// Fallback to Playwright click
		log.Printf("JavaScript click failed, trying Playwright click: %v", err)
		if err := page.Click(selector, playwright.PageClickOptions{
			Timeout: playwright.Float(30000),
			Force:   playwright.Bool(true), // Force click even if element is not actionable
		}); err != nil {
			return "", fmt.Errorf("failed to click download button: %w", err)
		}
	}

	// Wait for download to start and complete
	deadline := time.Now().Add(90 * time.Second)
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for time.Now().Before(deadline) {
		select {
		case download := <-downloadComplete:
			// Save the downloaded file
			filename := download.SuggestedFilename()
			if filename == "" {
				filename = "asx-companies.csv"
			}
			savePath := filepath.Join(absPath, filename)

			if err := download.SaveAs(savePath); err != nil {
				return "", fmt.Errorf("failed to save download: %w", err)
			}

			// Verify file exists and has content
			stat, err := os.Stat(savePath)
			if err != nil {
				return "", fmt.Errorf("downloaded file not found: %w", err)
			}
			if stat.Size() == 0 {
				return "", fmt.Errorf("downloaded file is empty")
			}

			log.Printf("Download completed: %s (size: %d bytes)", savePath, stat.Size())
			return savePath, nil

		case err := <-downloadFailed:
			return "", fmt.Errorf("download failed: %w", err)

		case <-ticker.C:
			// Fallback: check filesystem periodically for CSV files
			files, err := os.ReadDir(absPath)
			if err == nil {
				for _, f := range files {
					if strings.HasSuffix(strings.ToLower(f.Name()), ".csv") {
						filePath := filepath.Join(absPath, f.Name())
						if stat, err := os.Stat(filePath); err == nil && stat.Size() > 0 {
							log.Printf("CSV file found via filesystem polling: %s (size: %d bytes)", filePath, stat.Size())
							return filePath, nil
						}
					}
				}
			}

		case <-ctx.Done():
			return "", ctx.Err()
		}
	}

	return "", fmt.Errorf("download timed out: no completion event received and no CSV file found in %s", absPath)
}

// DownloadDirect attempts to download directly if URL is known (fallback)
func (s *ASXScraper) DownloadDirect(ctx context.Context, csvURL string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", csvURL, nil)
	if err != nil {
		return "", err
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("bad status: %s", resp.Status)
	}

	filename := "asx-companies.csv"
	outputPath := filepath.Join(s.downloadDir, filename)
	
	out, err := os.Create(outputPath)
	if err != nil {
		return "", err
	}
	defer out.Close()

	_, err = io.Copy(out, resp.Body)
	return outputPath, err
}
