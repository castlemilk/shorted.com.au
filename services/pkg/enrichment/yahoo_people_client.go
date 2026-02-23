package enrichment

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"sync"
	"time"
)

// YahooPeopleClient fetches company officer data from Yahoo Finance quoteSummary API
type YahooPeopleClient interface {
	GetCompanyOfficers(ctx context.Context, stockCode string) ([]YahooOfficer, error)
}

// YahooOfficer represents a company officer from Yahoo Finance
type YahooOfficer struct {
	Name           string
	Title          string
	Age            int
	YearBorn       int
	FiscalYear     int
	TotalPay       int64
	ExercisedValue int64
}

type yahooPeopleClient struct {
	client *http.Client
	mu     sync.Mutex
	crumb  string
}

// NewYahooPeopleClient creates a new Yahoo Finance people client
func NewYahooPeopleClient() YahooPeopleClient {
	jar, _ := cookiejar.New(nil)
	return &yahooPeopleClient{
		client: &http.Client{
			Timeout: 15 * time.Second,
			Jar:     jar,
		},
	}
}

const yahooUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

// getCrumb fetches a session cookie and crumb from Yahoo Finance
func (c *yahooPeopleClient) getCrumb(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.crumb != "" {
		return c.crumb, nil
	}

	// Step 1: Visit Yahoo Finance to get session cookies
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://finance.yahoo.com/quote/BHP.AX", nil)
	if err != nil {
		return "", fmt.Errorf("failed to create session request: %w", err)
	}
	req.Header.Set("User-Agent", yahooUserAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")

	resp, err := c.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to fetch session: %w", err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()

	// Step 2: Fetch the crumb using the session cookies
	crumbReq, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://query2.finance.yahoo.com/v1/test/getcrumb", nil)
	if err != nil {
		return "", fmt.Errorf("failed to create crumb request: %w", err)
	}
	crumbReq.Header.Set("User-Agent", yahooUserAgent)

	crumbResp, err := c.client.Do(crumbReq)
	if err != nil {
		return "", fmt.Errorf("failed to fetch crumb: %w", err)
	}
	defer func() { _ = crumbResp.Body.Close() }()

	if crumbResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(crumbResp.Body, 512))
		return "", fmt.Errorf("crumb request returned status %d: %s", crumbResp.StatusCode, string(body))
	}

	crumbBytes, err := io.ReadAll(io.LimitReader(crumbResp.Body, 256))
	if err != nil {
		return "", fmt.Errorf("failed to read crumb: %w", err)
	}

	crumb := strings.TrimSpace(string(crumbBytes))
	if crumb == "" {
		return "", fmt.Errorf("received empty crumb")
	}

	c.crumb = crumb
	return crumb, nil
}

// quoteSummaryResponse is the Yahoo Finance quoteSummary API response
type quoteSummaryResponse struct {
	QuoteSummary struct {
		Result []struct {
			AssetProfile struct {
				CompanyOfficers []struct {
					Name           string `json:"name"`
					Title          string `json:"title"`
					Age            *int   `json:"age"`
					YearBorn       *int   `json:"yearBorn"`
					FiscalYear     *int   `json:"fiscalYear"`
					TotalPay       *struct {
						Raw int64 `json:"raw"`
					} `json:"totalPay"`
					ExercisedValue *struct {
						Raw int64 `json:"raw"`
					} `json:"exercisedValue"`
				} `json:"companyOfficers"`
				Industry string `json:"industry"`
				Sector   string `json:"sector"`
				Website  string `json:"website"`
			} `json:"assetProfile"`
		} `json:"result"`
		Error *struct {
			Code        string `json:"code"`
			Description string `json:"description"`
		} `json:"error"`
	} `json:"quoteSummary"`
}

// GetCompanyOfficers fetches company officers from Yahoo Finance
func (c *yahooPeopleClient) GetCompanyOfficers(ctx context.Context, stockCode string) ([]YahooOfficer, error) {
	if strings.TrimSpace(stockCode) == "" {
		return nil, fmt.Errorf("stock code is required")
	}

	// Yahoo Finance uses .AX suffix for ASX stocks
	ticker := strings.ToUpper(strings.TrimSpace(stockCode))
	if !strings.HasSuffix(ticker, ".AX") {
		ticker = ticker + ".AX"
	}

	// Get crumb for authentication
	crumb, err := c.getCrumb(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get Yahoo Finance crumb: %w", err)
	}

	apiURL := fmt.Sprintf(
		"https://query2.finance.yahoo.com/v10/finance/quoteSummary/%s?modules=assetProfile&crumb=%s",
		ticker, crumb,
	)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("User-Agent", yahooUserAgent)

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("yahoo finance request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	// If we get 401, invalidate crumb and retry once
	if resp.StatusCode == http.StatusUnauthorized {
		_, _ = io.Copy(io.Discard, resp.Body)
		c.mu.Lock()
		c.crumb = ""
		c.mu.Unlock()

		crumb, err = c.getCrumb(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to refresh Yahoo Finance crumb: %w", err)
		}

		retryURL := fmt.Sprintf(
			"https://query2.finance.yahoo.com/v10/finance/quoteSummary/%s?modules=assetProfile&crumb=%s",
			ticker, crumb,
		)
		retryReq, err := http.NewRequestWithContext(ctx, http.MethodGet, retryURL, nil)
		if err != nil {
			return nil, fmt.Errorf("failed to create retry request: %w", err)
		}
		retryReq.Header.Set("User-Agent", yahooUserAgent)

		resp, err = c.client.Do(retryReq)
		if err != nil {
			return nil, fmt.Errorf("yahoo finance retry request failed: %w", err)
		}
		defer func() { _ = resp.Body.Close() }()
	}

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("yahoo finance returned status %d: %s", resp.StatusCode, string(body))
	}

	var result quoteSummaryResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	if result.QuoteSummary.Error != nil {
		return nil, fmt.Errorf("yahoo finance error: %s - %s",
			result.QuoteSummary.Error.Code, result.QuoteSummary.Error.Description)
	}

	if len(result.QuoteSummary.Result) == 0 {
		return nil, nil
	}

	profile := result.QuoteSummary.Result[0].AssetProfile
	officers := make([]YahooOfficer, 0, len(profile.CompanyOfficers))

	for _, o := range profile.CompanyOfficers {
		if o.Name == "" {
			continue
		}
		officer := YahooOfficer{
			Name:  o.Name,
			Title: o.Title,
		}
		if o.Age != nil {
			officer.Age = *o.Age
		}
		if o.YearBorn != nil {
			officer.YearBorn = *o.YearBorn
		}
		if o.FiscalYear != nil {
			officer.FiscalYear = *o.FiscalYear
		}
		if o.TotalPay != nil {
			officer.TotalPay = o.TotalPay.Raw
		}
		if o.ExercisedValue != nil {
			officer.ExercisedValue = o.ExercisedValue.Raw
		}
		officers = append(officers, officer)
	}

	return officers, nil
}
