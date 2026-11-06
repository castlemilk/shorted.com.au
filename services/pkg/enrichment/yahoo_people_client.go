package enrichment

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/yahoo"
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

// yahooPeopleClient reads assetProfile through the shared Yahoo session
// (services/pkg/yahoo: the crumb, the cookies and the 401 refresh).
type yahooPeopleClient struct {
	session *yahoo.Session
}

// NewYahooPeopleClient creates a new Yahoo Finance people client
func NewYahooPeopleClient() YahooPeopleClient {
	return &yahooPeopleClient{
		session: yahoo.NewSession(&yahoo.HTTPFetcher{
			Client:    &http.Client{Timeout: 15 * time.Second},
			UserAgent: yahooUserAgent,
		}),
	}
}

const yahooUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

// assetProfileResult is the assetProfile module of a quoteSummary result.
type assetProfileResult struct {
	AssetProfile struct {
		CompanyOfficers []struct {
			Name       string `json:"name"`
			Title      string `json:"title"`
			Age        *int   `json:"age"`
			YearBorn   *int   `json:"yearBorn"`
			FiscalYear *int   `json:"fiscalYear"`
			TotalPay   *struct {
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

	raw, err := c.session.QuoteSummary(ctx, ticker, []string{"assetProfile"})
	if err != nil {
		return nil, fmt.Errorf("yahoo finance: %w", err)
	}
	if raw == nil {
		return nil, nil
	}

	var result assetProfileResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	profile := result.AssetProfile
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
