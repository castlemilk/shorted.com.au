package enrichment

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/chromedp/chromedp"
)

// LinkedInPhotoClient scrapes LinkedIn profile photos using authenticated Chromium sessions.
// It uses a persistent user data directory so cookies survive across runs.
type LinkedInPhotoClient struct {
	email       string
	password    string
	headless    bool
	userDataDir string
	allocCtx    context.Context
	allocCancel context.CancelFunc
	ctx         context.Context
	ctxCancel   context.CancelFunc
	loggedIn    bool
	lastCall    time.Time
	callDelay   time.Duration
	logger      interface{ Infof(string, ...any); Warnf(string, ...any) }
}

// LinkedInPhotoLogger is the minimal logger interface for the photo client.
type LinkedInPhotoLogger interface {
	Infof(string, ...any)
	Warnf(string, ...any)
}

// NewLinkedInPhotoClient creates a new authenticated LinkedIn photo scraping client.
// Set headless=false for first login (to complete any verification challenges in the browser),
// then headless=true for subsequent runs (cookies persist in ~/.linkedin-scraper-profile).
func NewLinkedInPhotoClient(email, password string, headless bool, logger LinkedInPhotoLogger) *LinkedInPhotoClient {
	homeDir, _ := os.UserHomeDir()
	userDataDir := filepath.Join(homeDir, ".linkedin-scraper-profile")

	return &LinkedInPhotoClient{
		email:       email,
		password:    password,
		headless:    headless,
		userDataDir: userDataDir,
		callDelay:   4 * time.Second,
		logger:      logger,
	}
}

// Close releases browser resources.
func (c *LinkedInPhotoClient) Close() {
	if c.ctxCancel != nil {
		c.ctxCancel()
	}
	if c.allocCancel != nil {
		c.allocCancel()
	}
}

func (c *LinkedInPhotoClient) rateLimit() {
	if !c.lastCall.IsZero() {
		elapsed := time.Since(c.lastCall)
		if elapsed < c.callDelay {
			time.Sleep(c.callDelay - elapsed)
		}
	}
	c.lastCall = time.Now()
}

// ensureBrowser creates a persistent Chromium browser session with user data dir.
func (c *LinkedInPhotoClient) ensureBrowser() error {
	if c.ctx != nil {
		return nil
	}

	// Create profile directory if it doesn't exist
	if err := os.MkdirAll(c.userDataDir, 0o700); err != nil {
		return fmt.Errorf("failed to create user data dir: %w", err)
	}

	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.Flag("headless", c.headless),
		chromedp.Flag("disable-gpu", true),
		chromedp.Flag("no-sandbox", true),
		chromedp.Flag("disable-dev-shm-usage", true),
		chromedp.Flag("disable-blink-features", "AutomationControlled"),
		chromedp.UserDataDir(c.userDataDir),
		chromedp.UserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"),
		chromedp.WindowSize(1920, 1080),
		chromedp.WSURLReadTimeout(30*time.Second),
	)

	c.allocCtx, c.allocCancel = chromedp.NewExecAllocator(context.Background(), opts...)
	c.ctx, c.ctxCancel = chromedp.NewContext(c.allocCtx)

	// Navigate to blank page to initialize
	return chromedp.Run(c.ctx, chromedp.Navigate("about:blank"))
}

// Login authenticates with LinkedIn using email/password.
// If LinkedIn presents a verification challenge, it waits for manual completion (non-headless)
// or returns an error (headless).
func (c *LinkedInPhotoClient) Login(ctx context.Context) error {
	if c.loggedIn {
		return nil
	}

	if err := c.ensureBrowser(); err != nil {
		return fmt.Errorf("failed to start browser: %w", err)
	}

	// First check if we already have a valid session from persistent cookies
	c.logger.Infof("Checking for existing LinkedIn session...")
	if c.checkExistingSession() {
		c.loggedIn = true
		c.logger.Infof("Reusing existing LinkedIn session (cookies from previous login)")
		return nil
	}

	c.logger.Infof("No existing session — logging in to LinkedIn as %s", c.email)

	// Navigate to login page
	err := chromedp.Run(c.ctx,
		chromedp.Navigate("https://www.linkedin.com/login"),
		chromedp.WaitVisible(`#username`, chromedp.ByID),
	)
	if err != nil {
		return fmt.Errorf("failed to load login page: %w", err)
	}

	// Fill credentials and submit
	err = chromedp.Run(c.ctx,
		chromedp.Clear(`#username`, chromedp.ByID),
		chromedp.SendKeys(`#username`, c.email, chromedp.ByID),
		chromedp.Clear(`#password`, chromedp.ByID),
		chromedp.SendKeys(`#password`, c.password, chromedp.ByID),
		chromedp.Sleep(500*time.Millisecond),
		chromedp.Click(`button[type="submit"]`, chromedp.ByQuery),
	)
	if err != nil {
		return fmt.Errorf("failed to submit login form: %w", err)
	}

	// Wait for redirect
	time.Sleep(3 * time.Second)

	// Check current URL
	var currentURL string
	if err := chromedp.Run(c.ctx, chromedp.Location(&currentURL)); err != nil {
		return fmt.Errorf("failed to get current URL: %w", err)
	}

	c.logger.Infof("Post-login URL: %s", currentURL)

	// Handle verification challenge
	if strings.Contains(currentURL, "/challenge") || strings.Contains(currentURL, "/checkpoint") {
		if c.headless {
			return fmt.Errorf("LinkedIn requires verification challenge — run with --interactive first to complete it manually, then re-run in headless mode. Challenge URL: %s", currentURL)
		}

		// Non-headless mode: wait for user to complete challenge in the browser
		c.logger.Infof("LinkedIn verification challenge detected. Complete it in the browser window...")
		c.logger.Infof("Waiting up to 120 seconds for challenge completion...")

		for i := 0; i < 60; i++ {
			time.Sleep(2 * time.Second)
			if err := chromedp.Run(c.ctx, chromedp.Location(&currentURL)); err != nil {
				continue
			}
			if !strings.Contains(currentURL, "/challenge") && !strings.Contains(currentURL, "/checkpoint") {
				break
			}
		}

		// Re-check URL
		if err := chromedp.Run(c.ctx, chromedp.Location(&currentURL)); err != nil {
			return fmt.Errorf("failed to get URL after challenge: %w", err)
		}
		if strings.Contains(currentURL, "/challenge") || strings.Contains(currentURL, "/checkpoint") {
			return fmt.Errorf("verification challenge was not completed within timeout")
		}
	}

	if strings.Contains(currentURL, "/login") {
		return fmt.Errorf("login failed — still on login page: %s", currentURL)
	}

	c.loggedIn = true
	c.logger.Infof("Successfully logged in to LinkedIn (session saved to %s)", c.userDataDir)
	return nil
}

// checkExistingSession navigates to LinkedIn feed to test if cookies are still valid.
func (c *LinkedInPhotoClient) checkExistingSession() bool {
	err := chromedp.Run(c.ctx,
		chromedp.Navigate("https://www.linkedin.com/feed/"),
		chromedp.Sleep(2*time.Second),
	)
	if err != nil {
		return false
	}

	var currentURL string
	if err := chromedp.Run(c.ctx, chromedp.Location(&currentURL)); err != nil {
		return false
	}

	// If we're on the feed (not redirected to login), session is valid
	return strings.Contains(currentURL, "/feed") || strings.Contains(currentURL, "/in/")
}

// findPhotoFromDOM does a JavaScript-based search for profile images.
func (c *LinkedInPhotoClient) findPhotoFromDOM(_ context.Context) string {
	var imgSrcs []string
	err := chromedp.Run(c.ctx,
		chromedp.Evaluate(`
			(() => {
				// Method 1: Profile photo in the main content area (NOT nav bar)
				// Look for profile-displayphoto images that are large (not thumbnails)
				const mainContent = document.querySelector('main') || document.querySelector('.scaffold-layout__main') || document;
				const profilePhotos = Array.from(mainContent.querySelectorAll('img'))
					.filter(img => {
						const src = img.src || '';
						if (!src.includes('media.licdn.com') || !src.includes('profile-displayphoto')) return false;
						if (src.includes('ghost-person')) return false;
						// Filter out small nav thumbnails (shrink_100_100 is nav, shrink_200_200+ is profile)
						const rect = img.getBoundingClientRect();
						return rect.width >= 50;  // Profile photos are usually >= 100px
					})
					.map(img => img.src);
				if (profilePhotos.length > 0) return profilePhotos;

				// Method 2: Any profile-related image in the top card area
				const topCardImgs = Array.from(mainContent.querySelectorAll(
					'.pv-top-card img, .top-card-layout img, [data-section="PROFILE_PHOTO"] img, .pv-top-card-profile-picture img'
				))
					.map(img => img.src)
					.filter(src =>
						src && src.startsWith('http') &&
						!src.includes('ghost-person') &&
						!src.includes('data:') &&
						!src.includes('static-exp') &&
						!src.includes('shrink_48_48')
					);
				return topCardImgs;
			})()
		`, &imgSrcs),
	)
	if err != nil || len(imgSrcs) == 0 {
		return ""
	}

	return upgradeLinkedInPhotoSize(imgSrcs[0])
}

// FetchProfilePhotoViaAPI navigates to a LinkedIn profile and extracts the profile photo URL
// using DOM scraping of the authenticated view.
func (c *LinkedInPhotoClient) FetchProfilePhotoViaAPI(ctx context.Context, profileURL string) (string, error) {
	if !c.loggedIn {
		return "", fmt.Errorf("not logged in")
	}

	c.rateLimit()

	// Navigate to the profile page
	c.logger.Infof("  Navigating to profile: %s", profileURL)
	err := chromedp.Run(c.ctx,
		chromedp.Navigate(profileURL),
		chromedp.Sleep(3*time.Second),
	)
	if err != nil {
		return "", fmt.Errorf("failed to navigate to profile: %w", err)
	}

	// Extract photo URL from DOM
	photoURL := c.findPhotoFromDOM(ctx)
	if photoURL != "" {
		return photoURL, nil
	}
	return "", nil
}

// DownloadImageBytes downloads a LinkedIn image URL using the authenticated browser context.
// Navigates the browser to the image URL directly, then extracts the pixel data via canvas.
// This works because LinkedIn CDN images use signed tokens in the URL, and the browser
// renders standalone images as same-origin <img> elements that canvas can read.
func (c *LinkedInPhotoClient) DownloadImageBytes(_ context.Context, imageURL string) ([]byte, string, error) {
	if !c.loggedIn {
		return nil, "", fmt.Errorf("not logged in")
	}
	return c.downloadViaCanvas(imageURL)
}

// downloadViaCanvas navigates the browser directly to the image URL and extracts
// the image data via a canvas element. This works because when a browser navigates
// to an image URL, it renders as a same-origin <img>, so canvas can read its pixels.
func (c *LinkedInPhotoClient) downloadViaCanvas(imageURL string) ([]byte, string, error) {
	// Navigate directly to the image URL
	err := chromedp.Run(c.ctx,
		chromedp.Navigate(imageURL),
		chromedp.Sleep(3*time.Second),
	)
	if err != nil {
		return nil, "", fmt.Errorf("failed to navigate to image URL: %w", err)
	}

	// Check if the page loaded an image (browser renders standalone images as <img>)
	var dataURL string
	err = chromedp.Run(c.ctx,
		chromedp.Evaluate(`
			(() => {
				const img = document.querySelector('img');
				if (!img || img.naturalWidth === 0) return '';
				const canvas = document.createElement('canvas');
				canvas.width = img.naturalWidth;
				canvas.height = img.naturalHeight;
				const ctx = canvas.getContext('2d');
				ctx.drawImage(img, 0, 0);
				return canvas.toDataURL('image/jpeg', 0.95);
			})()
		`, &dataURL),
	)
	if err != nil {
		return nil, "", fmt.Errorf("canvas extraction failed: %w", err)
	}

	if dataURL == "" {
		return nil, "", fmt.Errorf("no image found at URL (page may have returned error)")
	}

	// Navigate back to LinkedIn so subsequent profile fetches work
	_ = chromedp.Run(c.ctx,
		chromedp.Navigate("https://www.linkedin.com/feed/"),
		chromedp.Sleep(1*time.Second),
	)

	return c.parseDataURL(dataURL)
}

// parseDataURL decodes a data:image/...;base64,... URL into raw bytes.
func (c *LinkedInPhotoClient) parseDataURL(dataURL string) ([]byte, string, error) {
	parts := strings.SplitN(dataURL, ",", 2)
	if len(parts) != 2 {
		return nil, "", fmt.Errorf("invalid data URL format")
	}

	// Extract content type from "data:image/jpeg;base64"
	contentType := "image/jpeg"
	header := parts[0]
	if strings.Contains(header, "image/png") {
		contentType = "image/png"
	} else if strings.Contains(header, "image/webp") {
		contentType = "image/webp"
	}

	data, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, "", fmt.Errorf("failed to decode base64 image: %w", err)
	}

	if len(data) < 1024 {
		return nil, "", fmt.Errorf("decoded image too small (%d bytes)", len(data))
	}

	return data, contentType, nil
}

// upgradeLinkedInPhotoSize replaces small photo URLs with larger versions.
func upgradeLinkedInPhotoSize(photoURL string) string {
	replacer := strings.NewReplacer(
		"shrink_100_100", "shrink_400_400",
		"shrink_200_200", "shrink_400_400",
		"shrink_48_48", "shrink_400_400",
		"shrink_72_72", "shrink_400_400",
	)
	return replacer.Replace(photoURL)
}
