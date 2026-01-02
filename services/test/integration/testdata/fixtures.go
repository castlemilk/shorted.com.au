package testdata

import (
	"time"
)

// Common test fixtures for integration tests

// GetSampleStocks returns a list of common ASX stocks for testing
func GetSampleStocks() []string {
	return []string{"CBA", "BHP", "CSL", "WBC", "NAB", "ANZ", "WOW", "WES", "FMG", "RIO"}
}

// NewShortData creates a short data record with sensible defaults
func NewShortData(productCode, productName string, date time.Time) ShortData {
	return ShortData{
		Date:              date,
		ProductCode:       productCode,
		ProductName:       productName,
		TotalShortPos:     1000000,
		DailyShortVol:     50000,
		PercentOfShares:   0.5,
		TotalProductIssue: 10000000,
	}
}

// NewCompanyMetadata creates company metadata with sensible defaults
func NewCompanyMetadata(stockCode, companyName string) CompanyMetadata {
	return CompanyMetadata{
		StockCode:   stockCode,
		CompanyName: companyName,
		Sector:      "Financial Services",
		Industry:    "Banks",
		MarketCap:   100000000000,
		LogoURL:     "https://example.com/logo.png",
		Website:     "https://example.com",
		Description: "Test company",
		Exchange:    "ASX",
		Tags:        []string{"financial-services", "banking", "finance"},
	}
}

// NewStockPrice creates stock price data with sensible defaults
func NewStockPrice(stockCode string, date time.Time, close float64) StockPrice {
	return StockPrice{
		StockCode: stockCode,
		Date:      date,
		Open:      close * 0.99,
		High:      close * 1.02,
		Low:       close * 0.98,
		Close:     close,
		Volume:    1000000,
	}
}

// GenerateShortTimeSeries generates a time series of short position data
func GenerateShortTimeSeries(productCode, productName string, startDate time.Time, days int, basePercent float64) []ShortData {
	shorts := make([]ShortData, days)
	
	for i := 0; i < days; i++ {
		date := startDate.AddDate(0, 0, i)
		// Add some variation to the short position
		variation := float64(i) * 0.01
		
		shorts[i] = ShortData{
			Date:              date,
			ProductCode:       productCode,
			ProductName:       productName,
			TotalShortPos:     1000000 + int64(i*10000),
			DailyShortVol:     50000 + int64(i*500),
			PercentOfShares:   basePercent + variation,
			TotalProductIssue: 10000000,
		}
	}
	
	return shorts
}

// GenerateStockPriceTimeSeries generates a time series of stock prices
func GenerateStockPriceTimeSeries(stockCode string, startDate time.Time, days int, startPrice float64) []StockPrice {
	prices := make([]StockPrice, days)
	currentPrice := startPrice
	
	for i := 0; i < days; i++ {
		date := startDate.AddDate(0, 0, i)
		// Random walk with slight upward bias
		change := 0.5 + float64(i%10)*0.1
		currentPrice += change
		
		prices[i] = NewStockPrice(stockCode, date, currentPrice)
	}
	
	return prices
}

// GetCBATestData returns comprehensive test data for CBA stock
func GetCBATestData(startDate time.Time, days int) ([]ShortData, CompanyMetadata, []StockPrice) {
	shorts := GenerateShortTimeSeries("CBA", "COMMONWEALTH BANK OF AUSTRALIA", startDate, days, 0.12)
	
	metadata := CompanyMetadata{
		StockCode:   "CBA",
		CompanyName: "Commonwealth Bank of Australia",
		Sector:      "Financial Services",
		Industry:    "Banks",
		MarketCap:   180000000000,
		LogoURL:     "https://example.com/cba.png",
		Website:     "https://commbank.com.au",
		Description: "Australia's largest bank by market capitalization",
		Exchange:    "ASX",
		Tags:        []string{"banking", "financial-services", "mortgages", "retail-banking"},
	}
	
	prices := GenerateStockPriceTimeSeries("CBA", startDate, days, 100.0)
	
	return shorts, metadata, prices
}

// GetBHPTestData returns comprehensive test data for BHP stock
func GetBHPTestData(startDate time.Time, days int) ([]ShortData, CompanyMetadata, []StockPrice) {
	shorts := GenerateShortTimeSeries("BHP", "BHP GROUP LIMITED", startDate, days, 0.89)
	
	metadata := CompanyMetadata{
		StockCode:   "BHP",
		CompanyName: "BHP Group Limited",
		Sector:      "Materials",
		Industry:    "Mining",
		MarketCap:   200000000000,
		LogoURL:     "https://example.com/bhp.png",
		Website:     "https://bhp.com",
		Description: "World's largest mining company",
		Exchange:    "ASX",
		Tags:        []string{"mining", "resources", "iron-ore", "copper", "commodities"},
	}
	
	prices := GenerateStockPriceTimeSeries("BHP", startDate, days, 45.0)
	
	return shorts, metadata, prices
}

// GetCSLTestData returns comprehensive test data for CSL stock
func GetCSLTestData(startDate time.Time, days int) ([]ShortData, CompanyMetadata, []StockPrice) {
	shorts := GenerateShortTimeSeries("CSL", "CSL LIMITED", startDate, days, 0.45)
	
	metadata := CompanyMetadata{
		StockCode:   "CSL",
		CompanyName: "CSL Limited",
		Sector:      "Healthcare",
		Industry:    "Biotechnology",
		MarketCap:   150000000000,
		LogoURL:     "https://example.com/csl.png",
		Website:     "https://csl.com",
		Description: "Global biotechnology company",
		Exchange:    "ASX",
		Tags:        []string{"healthcare", "biotech", "pharmaceuticals", "plasma"},
	}
	
	prices := GenerateStockPriceTimeSeries("CSL", startDate, days, 300.0)
	
	return shorts, metadata, prices
}

// GetMultipleStocksTestData returns test data for multiple stocks
func GetMultipleStocksTestData(stockCodes []string, startDate time.Time, days int) ([]ShortData, []CompanyMetadata, []StockPrice) {
	var allShorts []ShortData
	var allMetadata []CompanyMetadata
	var allPrices []StockPrice
	
	stockNames := map[string]string{
		"CBA": "COMMONWEALTH BANK OF AUSTRALIA",
		"BHP": "BHP GROUP LIMITED",
		"CSL": "CSL LIMITED",
		"WBC": "WESTPAC BANKING CORPORATION",
		"NAB": "NATIONAL AUSTRALIA BANK LIMITED",
		"ANZ": "AUSTRALIA AND NEW ZEALAND BANKING GROUP LIMITED",
		"WOW": "WOOLWORTHS GROUP LIMITED",
		"WES": "WESFARMERS LIMITED",
		"FMG": "FORTESCUE METALS GROUP LIMITED",
		"RIO": "RIO TINTO LIMITED",
	}
	
	for i, code := range stockCodes {
		name := stockNames[code]
		if name == "" {
			name = code + " TEST COMPANY"
		}
		
		basePercent := 0.1 + float64(i)*0.1
		basePrice := 50.0 + float64(i)*10.0
		
		shorts := GenerateShortTimeSeries(code, name, startDate, days, basePercent)
		allShorts = append(allShorts, shorts...)
		
		metadata := NewCompanyMetadata(code, name)
		allMetadata = append(allMetadata, metadata)
		
		prices := GenerateStockPriceTimeSeries(code, startDate, days, basePrice)
		allPrices = append(allPrices, prices...)
	}
	
	return allShorts, allMetadata, allPrices
}

// GetTopShortsTestData returns data specifically for testing GetTopShorts endpoint
func GetTopShortsTestData(numStocks int, date time.Time) ([]ShortData, []CompanyMetadata) {
	var shorts []ShortData
	var metadata []CompanyMetadata
	
	sampleStocks := GetSampleStocks()
	if numStocks > len(sampleStocks) {
		numStocks = len(sampleStocks)
	}
	
	for i := 0; i < numStocks; i++ {
		code := sampleStocks[i]
		short := NewShortData(code, code+" LIMITED", date)
		// Make each stock have a different short percentage for testing sorting
		short.PercentOfShares = float64(numStocks-i) * 0.1
		short.TotalShortPos = int64((numStocks - i) * 1000000)
		
		shorts = append(shorts, short)
		
		meta := NewCompanyMetadata(code, code+" Limited")
		metadata = append(metadata, meta)
	}
	
	return shorts, metadata
}

