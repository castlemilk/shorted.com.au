package shorts

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/jackc/pgtype"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/timestamppb"
)

const (
	companyMetadataTableName  = "company-metadata"
	stockDetailsQueryTemplate = `
SELECT 
	COALESCE(stock_code, '') as stock_code,
	COALESCE(company_name, '') as company_name,
	COALESCE(industry, '') as industry,
	COALESCE(address, '') as address,
	COALESCE(summary, '') as summary,
	COALESCE(details, '') as details,
	COALESCE(website, '') as website,
	%s,
	COALESCE(tags, ARRAY[]::text[]) as tags,
	COALESCE(enhanced_summary, '') as enhanced_summary,
	COALESCE(company_history, '') as company_history,
	COALESCE(key_people, '[]'::jsonb) as key_people,
	COALESCE(financial_reports, '[]'::jsonb) as financial_reports,
	COALESCE(competitive_advantages, '') as competitive_advantages,
	COALESCE(risk_factors, '') as risk_factors,
	COALESCE(recent_developments, '') as recent_developments,
	COALESCE(social_media_links, '{}'::jsonb) as social_media_links,
	COALESCE(enrichment_status, '') as enrichment_status,
	enrichment_date,
	COALESCE(enrichment_error, '') as enrichment_error,
	COALESCE(financial_statements, '{}'::jsonb) as financial_statements,
	COALESCE(key_metrics, '{}'::jsonb) as key_metrics,
	COALESCE(logo_icon_gcs_url, '') as logo_icon_gcs_url,
	COALESCE(logo_svg_gcs_url, '') as logo_svg_gcs_url,
	COALESCE(logo_source_url, '') as logo_source_url,
	COALESCE(logo_format, '') as logo_format
FROM "company-metadata"
WHERE stock_code = $1
LIMIT 1`
)

// postgresStore implements the Store interface for a PostgreSQL backend.
type postgresStore struct {
	db                *pgxpool.Pool
	stockDetailsQuery string
}

// newPostgresStore initializes a new store with a PostgreSQL backend.
func newPostgresStore(config Config) Store {
	// Configure connection pool for better concurrency
	poolConfig, err := pgxpool.ParseConfig(fmt.Sprintf("postgres://%s:%s@%s/%s",
		config.PostgresUsername, config.PostgresPassword, config.PostgresAddress, config.PostgresDatabase))
	if err != nil {
		panic("Unable to parse database config: " + err.Error())
	}

	// IMPORTANT: Use simple protocol mode to avoid prepared statement cache conflicts
	// with pooled Postgres connections (e.g. Supabase/pgbouncer).
	//
	// Without this, Postgres can return:
	//   ERROR: prepared statement "stmtcache_..." already exists (SQLSTATE 42P05)
	poolConfig.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol

	// Set connection pool settings for better concurrency
	poolConfig.MaxConns = 25                      // Maximum number of connections
	poolConfig.MinConns = 5                       // Minimum number of connections
	poolConfig.MaxConnLifetime = time.Hour        // Maximum connection lifetime
	poolConfig.MaxConnIdleTime = time.Minute * 30 // Maximum idle time

	dbPool, err := pgxpool.NewWithConfig(context.Background(), poolConfig)
	if err != nil {
		panic("Unable to connect to database: " + err.Error())
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	stockDetailsQuery, err := buildStockDetailsQuery(ctx, dbPool)
	if err != nil {
		panic("Unable to build stock details query: " + err.Error())
	}

	return &postgresStore{
		db:                dbPool,
		stockDetailsQuery: stockDetailsQuery,
	}
}

func buildStockDetailsQuery(ctx context.Context, db *pgxpool.Pool) (string, error) {
	// Only use GCS URLs - no fallback to external company_logo_link
	logoExpr := `COALESCE(logo_gcs_url, ''::text) as logo_gcs_url`
	log.Infof("Using logo_gcs_url only (no external URL fallback)")

	return fmt.Sprintf(stockDetailsQueryTemplate, logoExpr), nil
}

// GetStock retrieves a single stock by its ID, including metadata.
func (s *postgresStore) GetStock(productCode string) (*stocksv1alpha1.Stock, error) {
	query := `
SELECT 
	s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" as percentage_shorted,
	s."PRODUCT_CODE" as product_code,
	s."PRODUCT" as name, 
	s."TOTAL_PRODUCT_IN_ISSUE" as total_product_in_issue, 
	s."REPORTED_SHORT_POSITIONS" as reported_short_positions,
	COALESCE(m.industry, '') as industry,
	COALESCE(m.tags, ARRAY[]::text[]) as tags,
	COALESCE(m.logo_gcs_url, '') as logo_url
FROM shorts s
LEFT JOIN "company-metadata" m ON s."PRODUCT_CODE" = m.stock_code
WHERE s."PRODUCT_CODE" = $1 
ORDER BY s."DATE" DESC LIMIT 1`

	rows, err := s.db.Query(context.Background(), query, productCode)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	if !rows.Next() {
		return nil, fmt.Errorf("stock not found: %s", productCode)
	}

	stock := &stocksv1alpha1.Stock{}
	if err := rows.Scan(
		&stock.PercentageShorted,
		&stock.ProductCode,
		&stock.Name,
		&stock.TotalProductInIssue,
		&stock.ReportedShortPositions,
		&stock.Industry,
		&stock.Tags,
		&stock.LogoUrl,
	); err != nil {
		return nil, err
	}
	return stock, nil
}

// GetTop10Shorts retrieves the top 10 shorted stocks.
func (s *postgresStore) GetTopShorts(period string, limit int32, offset int32) ([]*stocksv1alpha1.TimeSeriesData, int, error) {
	// You'll need to adjust FetchTimeSeriesData to use pgx as well.
	return FetchTimeSeriesData(s.db, int(limit), int(offset), period)
}

// GetStockData retrieves the time series data for a single stock, downsampling it for performance.
func (s *postgresStore) GetStockData(productCode, period string) (*stocksv1alpha1.TimeSeriesData, error) {
	// Define the interval for downsampling (e.g., 'day', 'week', 'month')
	var interval string
	switch period {
	case "1D", "1d":
		interval = "day"
	case "1W", "1w":
		interval = "day"
	case "1M", "1m":
		interval = "day"
	case "3M", "3m":
		interval = "day"
	case "6M", "6m":
		interval = "day"
	case "1Y", "1y":
		interval = "day"
	case "2Y", "2y":
		interval = "day"
	case "5Y", "5y":
		interval = "week"
	case "10Y", "10y":
		interval = "week"
	case "MAX", "max":
		interval = "week"
	default:
		interval = "day"
	}

	// Uses MAX(DATE) instead of CURRENT_DATE to work with historical data
	query := fmt.Sprintf(`
		SELECT date_trunc('%s', "DATE") as interval_start, 
		       AVG("PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS") as avg_percent
		FROM shorts
		WHERE "PRODUCT_CODE" = $1
		  AND "DATE" > (SELECT MAX("DATE") FROM shorts) - INTERVAL '%s'
		  AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" IS NOT NULL
		GROUP BY interval_start
		ORDER BY interval_start ASC`, interval, periodToInterval(period))

	rows, err := s.db.Query(context.Background(), query, productCode)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var points []*stocksv1alpha1.TimeSeriesPoint
	for rows.Next() {
		var date pgtype.Timestamp
		var percent pgtype.Float8
		if err := rows.Scan(&date, &percent); err != nil {
			return nil, err
		}
		// Skip if the date or percent is null
		if date.Status != pgtype.Present || percent.Status != pgtype.Present {
			continue
		}
		point := &stocksv1alpha1.TimeSeriesPoint{
			Timestamp:     timestamppb.New(date.Time),
			ShortPosition: percent.Float,
		}
		points = append(points, point)
	}
	if rows.Err() != nil {
		return nil, rows.Err()
	}

	// Return time series data even if there are fewer than 10 points
	if len(points) > 0 {
		return &stocksv1alpha1.TimeSeriesData{
			ProductCode:         productCode,
			Points:              points,
			LatestShortPosition: points[len(points)-1].ShortPosition,
		}, nil
	}
	// Return empty time series data if no points found
	return &stocksv1alpha1.TimeSeriesData{
		ProductCode:         productCode,
		Points:              []*stocksv1alpha1.TimeSeriesPoint{},
		LatestShortPosition: 0,
	}, nil
}

// GetStockDetails implements Store.
// fetch the stock metadata following the schema:
/**
Table "public.metadata"
      Column       | Type | Collation | Nullable | Default
-------------------+------+-----------+----------+---------
 company_name      | text |           |          |
 address           | text |           |          |
 summary           | text |           |          |
 details           | text |           |          |
 website           | text |           |          |
 stock_code        | text |           |          |
 links             | text |           |          |
 images            | text |           |          |
 company_logo_link | text |           |          |
 gcsUrl            | text |           |          |
*/
func (s *postgresStore) GetStockDetails(stockCode string) (*stocksv1alpha1.StockDetails, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	row := s.db.QueryRow(ctx, s.stockDetailsQuery, stockCode)

	var (
		productCode,
		companyName,
		industry,
		address,
		summary,
		details,
		website,
		logoGCSURL sql.NullString
		enhancedSummary         sql.NullString
		companyHistory          sql.NullString
		competitiveAdvantages   sql.NullString
		riskFactors             sql.NullString
		recentDevelopments      sql.NullString
		enrichmentStatus        sql.NullString
		enrichmentError         sql.NullString
		enrichmentDate          pgtype.Timestamptz
		tags                    []string
		keyPeopleJSON           []byte
		financialReportsJSON    []byte
		socialMediaLinksJSON    []byte
		financialStatementsJSON []byte
		keyMetricsJSON          []byte
		logoIconGcsURL          sql.NullString
		logoSvgGcsURL           sql.NullString
		logoSourceURL           sql.NullString
		logoFormat              sql.NullString
	)

	if err := row.Scan(
		&productCode,
		&companyName,
		&industry,
		&address,
		&summary,
		&details,
		&website,
		&logoGCSURL,
		&tags,
		&enhancedSummary,
		&companyHistory,
		&keyPeopleJSON,
		&financialReportsJSON,
		&competitiveAdvantages,
		&riskFactors,
		&recentDevelopments,
		&socialMediaLinksJSON,
		&enrichmentStatus,
		&enrichmentDate,
		&enrichmentError,
		&financialStatementsJSON,
		&keyMetricsJSON,
		&logoIconGcsURL,
		&logoSvgGcsURL,
		&logoSourceURL,
		&logoFormat,
	); err != nil {
		// If no metadata exists, check if the stock exists in shorts table
		// and return minimal details if it does
		if errors.Is(err, pgx.ErrNoRows) {
			return s.getMinimalStockDetails(ctx, stockCode)
		}
		return nil, err
	}

	detailsProto := &stocksv1alpha1.StockDetails{
		ProductCode:           productCode.String,
		CompanyName:           companyName.String,
		Industry:              industry.String,
		Address:               address.String,
		Summary:               summary.String,
		Details:               details.String,
		Website:               website.String,
		GcsUrl:                logoGCSURL.String,
		Tags:                  tags,
		EnhancedSummary:       enhancedSummary.String,
		CompanyHistory:        companyHistory.String,
		CompetitiveAdvantages: competitiveAdvantages.String,
		RecentDevelopments:    recentDevelopments.String,
		SocialMediaLinks:      parseSocialMediaLinks(socialMediaLinksJSON),
		EnrichmentStatus:      enrichmentStatus.String,
		EnrichmentError:       enrichmentError.String,
		LogoGcsUrl:            logoGCSURL.String, // Same as GcsUrl for backward compatibility
		LogoIconGcsUrl:        logoIconGcsURL.String,
		LogoSvgGcsUrl:         logoSvgGcsURL.String,
		LogoSourceUrl:         logoSourceURL.String,
		LogoFormat:            logoFormat.String,
	}

	if enrichmentDate.Status == pgtype.Present {
		detailsProto.EnrichmentDate = timestamppb.New(enrichmentDate.Time)
	}

	if keyPeople, err := parseKeyPeople(keyPeopleJSON); err == nil {
		detailsProto.KeyPeople = keyPeople
	}

	if reports, err := parseFinancialReports(financialReportsJSON); err == nil {
		detailsProto.FinancialReports = reports
	}

	if rf := strings.TrimSpace(riskFactors.String); rf != "" {
		if parsed, err := parseStringArray([]byte(rf)); err == nil {
			detailsProto.RiskFactors = parsed
		} else {
			detailsProto.RiskFactors = []string{riskFactors.String}
		}
	}

	// Parse financial statements
	fs := parseFinancialStatements(financialStatementsJSON)
	
	// Parse key_metrics and merge with financial_statements info
	if !isEmptyJSON(keyMetricsJSON) {
		var keyMetrics map[string]interface{}
		if err := json.Unmarshal(keyMetricsJSON, &keyMetrics); err == nil {
			// If no financial_statements, create a minimal one with just info
			if fs == nil {
				fs = &stocksv1alpha1.FinancialStatements{
					Success: true,
				}
			}
			// Merge key_metrics into financial_statements.info
			fs.Info = mergeKeyMetricsToInfo(keyMetrics, fs.Info)
		}
	}
	
	if fs != nil {
		detailsProto.FinancialStatements = fs
	}

	return detailsProto, nil
}

// getMinimalStockDetails returns minimal stock details from the shorts table
// when company-metadata doesn't exist. This provides graceful degradation
// for stocks that have short position data but no enriched metadata yet.
func (s *postgresStore) getMinimalStockDetails(ctx context.Context, stockCode string) (*stocksv1alpha1.StockDetails, error) {
	query := `
		SELECT "PRODUCT_CODE", "PRODUCT"
		FROM shorts
		WHERE "PRODUCT_CODE" = $1
		ORDER BY "DATE" DESC
		LIMIT 1`

	var productCode, productName string
	err := s.db.QueryRow(ctx, query, stockCode).Scan(&productCode, &productName)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("stock not found: %s", stockCode)
		}
		return nil, err
	}

	// Return minimal details with just the stock code and company name from shorts table
	return &stocksv1alpha1.StockDetails{
		ProductCode:      productCode,
		CompanyName:      cleanCompanyName(productName),
		EnrichmentStatus: "pending", // Indicate that enrichment hasn't been done yet
	}, nil
}

// cleanCompanyName removes common suffixes like "ORDINARY", "CDI", etc. for cleaner display
func cleanCompanyName(name string) string {
	// Remove common suffixes
	suffixes := []string{
		" ORDINARY",
		" ORD",
		" CDI 1:1",
		" CDI",
		" LIMITED",
		" LTD",
		" CORPORATION",
		" CORP",
		" INC",
		" PLC",
	}
	
	result := strings.ToUpper(name)
	for _, suffix := range suffixes {
		if strings.HasSuffix(result, suffix) {
			result = strings.TrimSuffix(result, suffix)
		}
	}
	
	// Title case the result
	return strings.Title(strings.ToLower(strings.TrimSpace(result)))
}

type dbPerson struct {
	Name string `json:"name"`
	Role string `json:"role"`
	Bio  string `json:"bio"`
}

type dbFinancialReport struct {
	URL    string `json:"url"`
	Title  string `json:"title"`
	Type   string `json:"type"`
	Date   string `json:"date"`
	Source string `json:"source"`
	GCSURL string `json:"gcsUrl"`
}

type dbSocialMediaLinks struct {
	Twitter  *string `json:"twitter"`
	LinkedIn *string `json:"linkedin"`
	Facebook *string `json:"facebook"`
	YouTube  *string `json:"youtube"`
	Website  *string `json:"website"`
}

type dbFinancialStatementsInfo struct {
	MarketCap     *float64 `json:"market_cap"`
	CurrentPrice  *float64 `json:"current_price"`
	PeRatio       *float64 `json:"pe_ratio"`
	Eps           *float64 `json:"eps"`
	DividendYield *float64 `json:"dividend_yield"`
	Beta          *float64 `json:"beta"`
	Week52High    *float64 `json:"week_52_high"`
	Week52Low     *float64 `json:"week_52_low"`
	Volume        *float64 `json:"volume"`
	EmployeeCount *float64 `json:"employee_count"`
	Sector        *string  `json:"sector"`
	Industry      *string  `json:"industry"`
}

type dbFinancialStatements struct {
	Success   bool                       `json:"success"`
	Annual    *dbFinancialStatementSet   `json:"annual"`
	Quarterly *dbFinancialStatementSet   `json:"quarterly"`
	Info      *dbFinancialStatementsInfo `json:"info"`
	Error     string                     `json:"error"`
}

type dbFinancialStatementSet struct {
	IncomeStatement map[string]map[string]*float64 `json:"income_statement"`
	BalanceSheet    map[string]map[string]*float64 `json:"balance_sheet"`
	CashFlow        map[string]map[string]*float64 `json:"cash_flow"`
}

func parseKeyPeople(data []byte) ([]*stocksv1alpha1.CompanyPerson, error) {
	if isEmptyJSON(data) {
		return nil, nil
	}
	var raw []dbPerson
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	people := make([]*stocksv1alpha1.CompanyPerson, 0, len(raw))
	for _, person := range raw {
		if person.Name == "" && person.Role == "" && person.Bio == "" {
			continue
		}
		people = append(people, &stocksv1alpha1.CompanyPerson{
			Name: person.Name,
			Role: person.Role,
			Bio:  person.Bio,
		})
	}
	return people, nil
}

func parseFinancialReports(data []byte) ([]*stocksv1alpha1.FinancialReport, error) {
	if isEmptyJSON(data) {
		return nil, nil
	}
	var raw []dbFinancialReport
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	reports := make([]*stocksv1alpha1.FinancialReport, 0, len(raw))
	for _, report := range raw {
		if report.URL == "" {
			continue
		}
		reports = append(reports, &stocksv1alpha1.FinancialReport{
			Url:    report.URL,
			Title:  report.Title,
			Type:   report.Type,
			Date:   report.Date,
			Source: report.Source,
			GcsUrl: report.GCSURL,
		})
	}
	return reports, nil
}

func parseSocialMediaLinks(data []byte) *stocksv1alpha1.SocialMediaLinks {
	if isEmptyJSON(data) {
		return nil
	}
	var links dbSocialMediaLinks
	if err := json.Unmarshal(data, &links); err != nil {
		return nil
	}
	result := &stocksv1alpha1.SocialMediaLinks{}
	var hasValue bool
	if links.Twitter != nil {
		result.Twitter = *links.Twitter
		hasValue = true
	}
	if links.LinkedIn != nil {
		result.Linkedin = *links.LinkedIn
		hasValue = true
	}
	if links.Facebook != nil {
		result.Facebook = *links.Facebook
		hasValue = true
	}
	if links.YouTube != nil {
		result.Youtube = *links.YouTube
		hasValue = true
	}
	if links.Website != nil {
		result.Website = *links.Website
		hasValue = true
	}
	if !hasValue {
		return nil
	}
	return result
}

func parseStringArray(data []byte) ([]string, error) {
	if isEmptyJSON(data) {
		return nil, nil
	}
	var vals []string
	if err := json.Unmarshal(data, &vals); err != nil {
		return nil, err
	}
	return vals, nil
}

func parseFinancialStatements(data []byte) *stocksv1alpha1.FinancialStatements {
	if isEmptyJSON(data) {
		return nil
	}
	var raw dbFinancialStatements
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil
	}
	statements := &stocksv1alpha1.FinancialStatements{
		Success:   raw.Success,
		Error:     raw.Error,
		Annual:    convertStatementSet(raw.Annual),
		Quarterly: convertStatementSet(raw.Quarterly),
		Info:      convertFinancialInfo(raw.Info),
	}
	if statements.Info == nil && statements.Annual == nil && statements.Quarterly == nil && !statements.Success && statements.Error == "" {
		return nil
	}
	return statements
}

func convertStatementSet(src *dbFinancialStatementSet) *stocksv1alpha1.FinancialStatementSet {
	if src == nil {
		return nil
	}
	set := &stocksv1alpha1.FinancialStatementSet{
		IncomeStatement: convertStatementMap(src.IncomeStatement),
		BalanceSheet:    convertStatementMap(src.BalanceSheet),
		CashFlow:        convertStatementMap(src.CashFlow),
	}
	if len(set.IncomeStatement) == 0 {
		set.IncomeStatement = nil
	}
	if len(set.BalanceSheet) == 0 {
		set.BalanceSheet = nil
	}
	if len(set.CashFlow) == 0 {
		set.CashFlow = nil
	}
	if set.IncomeStatement == nil && set.BalanceSheet == nil && set.CashFlow == nil {
		return nil
	}
	return set
}

func convertStatementMap(src map[string]map[string]*float64) map[string]*stocksv1alpha1.StatementValues {
	if len(src) == 0 {
		return nil
	}
	result := make(map[string]*stocksv1alpha1.StatementValues, len(src))
	for period, metrics := range src {
		if len(metrics) == 0 {
			continue
		}
		values := &stocksv1alpha1.StatementValues{
			Metrics: make(map[string]float64, len(metrics)),
		}
		for key, val := range metrics {
			if val == nil {
				continue
			}
			values.Metrics[key] = *val
		}
		if len(values.Metrics) > 0 {
			result[period] = values
		}
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

func convertFinancialInfo(info *dbFinancialStatementsInfo) *stocksv1alpha1.FinancialStatementsInfo {
	if info == nil {
		return nil
	}
	fsInfo := &stocksv1alpha1.FinancialStatementsInfo{}
	var hasValue bool

	// Helper to check for valid non-zero values
	isValidFloat := func(f *float64) bool {
		return f != nil && *f != 0
	}
	isValidString := func(s *string) bool {
		if s == nil {
			return false
		}
		trimmed := strings.TrimSpace(*s)
		if trimmed == "" || trimmed == "0" || trimmed == "0.0" || trimmed == "0000" {
			return false
		}
		return true
	}

	if isValidFloat(info.MarketCap) {
		fsInfo.MarketCap = *info.MarketCap
		hasValue = true
	}
	if isValidFloat(info.CurrentPrice) {
		fsInfo.CurrentPrice = *info.CurrentPrice
		hasValue = true
	}
	if isValidFloat(info.PeRatio) {
		fsInfo.PeRatio = *info.PeRatio
		hasValue = true
	}
	if isValidFloat(info.Eps) {
		fsInfo.Eps = *info.Eps
		hasValue = true
	}
	if isValidFloat(info.DividendYield) {
		fsInfo.DividendYield = *info.DividendYield
		hasValue = true
	}
	if isValidFloat(info.Beta) {
		fsInfo.Beta = *info.Beta
		hasValue = true
	}
	if isValidFloat(info.Week52High) {
		fsInfo.Week_52High = *info.Week52High
		hasValue = true
	}
	if isValidFloat(info.Week52Low) {
		fsInfo.Week_52Low = *info.Week52Low
		hasValue = true
	}
	if isValidFloat(info.Volume) {
		fsInfo.Volume = *info.Volume
		hasValue = true
	}
	if info.EmployeeCount != nil && *info.EmployeeCount > 0 {
		fsInfo.EmployeeCount = int64(*info.EmployeeCount)
		hasValue = true
	}
	if isValidString(info.Sector) {
		fsInfo.Sector = *info.Sector
		hasValue = true
	}
	if isValidString(info.Industry) {
		fsInfo.Industry = *info.Industry
		hasValue = true
	}

	if !hasValue {
		return nil
	}
	return fsInfo
}

func isEmptyJSON(data []byte) bool {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return true
	}
	switch string(trimmed) {
	case "[]", "{}", "null", `""`:
		return true
	default:
		return false
	}
}

// mergeKeyMetricsToInfo merges key_metrics JSONB data with existing financial_statements.info
// This allows us to use key_metrics data from the daily sync when financial_statements.info is empty
func mergeKeyMetricsToInfo(keyMetrics map[string]interface{}, existing *stocksv1alpha1.FinancialStatementsInfo) *stocksv1alpha1.FinancialStatementsInfo {
	// Initialize info if it doesn't exist
	if existing == nil {
		existing = &stocksv1alpha1.FinancialStatementsInfo{}
	}

	// Helper to safely convert interface{} to float64, returning 0 if invalid or zero
	toFloat64 := func(v interface{}) float64 {
		if v == nil {
			return 0
		}
		var f float64
		switch val := v.(type) {
		case float64:
			f = val
		case float32:
			f = float64(val)
		case int:
			f = float64(val)
		case int64:
			f = float64(val)
		case string:
			trimmed := strings.TrimSpace(val)
			if trimmed == "" || trimmed == "0" || trimmed == "0.0" || trimmed == "0000" {
				return 0
			}
			if _, err := fmt.Sscanf(trimmed, "%f", &f); err != nil {
				return 0
			}
		default:
			return 0
		}
		return f
	}

	// Helper to safely convert interface{} to int64, returning 0 if invalid or zero
	toInt64 := func(v interface{}) int64 {
		if v == nil {
			return 0
		}
		switch val := v.(type) {
		case int:
			return int64(val)
		case int64:
			return val
		case float64:
			return int64(val)
		case float32:
			return int64(val)
		case string:
			trimmed := strings.TrimSpace(val)
			if trimmed == "" || trimmed == "0" || trimmed == "0.0" || trimmed == "0000" {
				return 0
			}
			var i int64
			if _, err := fmt.Sscanf(trimmed, "%d", &i); err != nil {
				return 0
			}
			return i
		default:
			return 0
		}
	}

	// Helper to safely convert interface{} to string, returning "" if invalid or zero-like
	toString := func(v interface{}) string {
		if v == nil {
			return ""
		}
		if str, ok := v.(string); ok {
			trimmed := strings.TrimSpace(str)
			if trimmed == "" || trimmed == "0" || trimmed == "0.0" || trimmed == "0000" {
				return ""
			}
			return trimmed
		}
		return ""
	}

	// Merge each field, preferring existing values over key_metrics
	if existing.MarketCap == 0 {
		existing.MarketCap = toFloat64(keyMetrics["market_cap"])
	}
	if existing.CurrentPrice == 0 {
		existing.CurrentPrice = toFloat64(keyMetrics["current_price"])
	}
	if existing.PeRatio == 0 {
		existing.PeRatio = toFloat64(keyMetrics["pe_ratio"])
	}
	if existing.Eps == 0 {
		existing.Eps = toFloat64(keyMetrics["eps"])
	}
	if existing.DividendYield == 0 {
		existing.DividendYield = toFloat64(keyMetrics["dividend_yield"])
	}
	if existing.Beta == 0 {
		existing.Beta = toFloat64(keyMetrics["beta"])
	}
	if existing.Week_52High == 0 {
		existing.Week_52High = toFloat64(keyMetrics["fifty_two_week_high"])
	}
	if existing.Week_52Low == 0 {
		existing.Week_52Low = toFloat64(keyMetrics["fifty_two_week_low"])
	}
	if existing.Volume == 0 {
		existing.Volume = toFloat64(keyMetrics["avg_volume"])
	}
	if existing.EmployeeCount == 0 {
		existing.EmployeeCount = toInt64(keyMetrics["employee_count"])
	}
	if existing.Sector == "" {
		existing.Sector = toString(keyMetrics["sector"])
	}
	if existing.Industry == "" {
		existing.Industry = toString(keyMetrics["industry"])
	}

	return existing
}

// GetHeatmapData retrieves the top shorted stocks by industry.
func (s *postgresStore) GetIndustryTreeMap(limit int32, period string, viewMode string) (*stocksv1alpha1.IndustryTreeMap, error) {
	return FetchTreeMapData(s.db, limit, period, viewMode)
}

func (s *postgresStore) RegisterEmail(email string) error {
	query := `insert into "subscriptions" (email) values ($1)`
	_, err := s.db.Exec(context.Background(), query, email)
	return err
}

// GetAllStockCodes retrieves all stock codes from company-metadata
func (s *postgresStore) GetAllStockCodes() ([]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	query := `SELECT stock_code FROM "company-metadata" WHERE stock_code IS NOT NULL ORDER BY stock_code`
	rows, err := s.db.Query(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var stockCodes []string
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return nil, err
		}
		stockCodes = append(stockCodes, code)
	}

	return stockCodes, rows.Err()
}

// StockExists checks if a stock exists in company-metadata
func (s *postgresStore) StockExists(stockCode string) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var exists bool
	query := `SELECT EXISTS(SELECT 1 FROM "company-metadata" WHERE stock_code = $1)`
	err := s.db.QueryRow(ctx, query, stockCode).Scan(&exists)
	return exists, err
}

// UpdateKeyMetrics updates the key_metrics column for a stock
func (s *postgresStore) UpdateKeyMetrics(stockCode string, metrics map[string]interface{}) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	metricsJSON, err := json.Marshal(metrics)
	if err != nil {
		return fmt.Errorf("failed to marshal metrics: %w", err)
	}

	query := `
		UPDATE "company-metadata"
		SET 
			key_metrics = $2::jsonb,
			key_metrics_updated_at = CURRENT_TIMESTAMP
		WHERE stock_code = $1
	`
	
	result, err := s.db.Exec(ctx, query, stockCode, metricsJSON)
	if err != nil {
		return fmt.Errorf("failed to update key_metrics: %w", err)
	}

	if result.RowsAffected() == 0 {
		return fmt.Errorf("stock not found: %s", stockCode)
	}

	return nil
}

// SearchStocks searches for stocks by symbol or company name, including industry and tags
func (s *postgresStore) SearchStocks(query string, limit int32) ([]*stocksv1alpha1.Stock, error) {
	// Optimized search query using full-text search across rich metadata
	searchQuery := `
		WITH latest_shorts AS (
			SELECT DISTINCT ON ("PRODUCT_CODE") 
				"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS",
				"PRODUCT_CODE",
				"PRODUCT",
				"TOTAL_PRODUCT_IN_ISSUE",
				"REPORTED_SHORT_POSITIONS",
				"DATE"
			FROM shorts
			ORDER BY "PRODUCT_CODE", "DATE" DESC
		),
		search_results AS (
			SELECT 
				s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" as percentage_shorted,
				s."PRODUCT_CODE" as product_code,
				s."PRODUCT" as name,
				s."TOTAL_PRODUCT_IN_ISSUE" as total_product_in_issue,
				s."REPORTED_SHORT_POSITIONS" as reported_short_positions,
				COALESCE(m.industry, '') as industry,
				COALESCE(m.tags, ARRAY[]::text[]) as tags,
				COALESCE(m.logo_gcs_url, '') as logo_url,
				CASE 
					WHEN s."PRODUCT_CODE" = $1 THEN 100  -- Exact Code Match (Highest Priority)
					WHEN s."PRODUCT_CODE" ILIKE $2 THEN 50  -- Partial Code Match
					WHEN m.search_vector @@ plainto_tsquery('english', $1) THEN ts_rank(m.search_vector, plainto_tsquery('english', $1)) * 10
					WHEN s."PRODUCT" ILIKE $2 THEN 20       -- Name Match (fallback if not in search vector)
					ELSE 1
				END as relevance
			FROM latest_shorts s
			LEFT JOIN "company-metadata" m ON s."PRODUCT_CODE" = m.stock_code
			WHERE 
				s."PRODUCT_CODE" = $1 OR
				s."PRODUCT_CODE" ILIKE $2 OR
				s."PRODUCT" ILIKE $2 OR
				m.search_vector @@ plainto_tsquery('english', $1)
		)
		SELECT 
			percentage_shorted, 
			product_code, 
			name, 
			total_product_in_issue, 
			reported_short_positions, 
			industry,
			tags,
			logo_url
		FROM search_results
		ORDER BY relevance DESC, percentage_shorted DESC
		LIMIT $3`

	// Create context with timeout to prevent hanging
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Prepare search patterns
	exactQuery := query
	partialQuery := "%" + query + "%"

	rows, err := s.db.Query(ctx, searchQuery, exactQuery, partialQuery, limit)
	if err != nil {
		log.Errorf("Database query failed for search '%s': %v", query, err)
		// Check if it's a context timeout
		if ctx.Err() == context.DeadlineExceeded {
			log.Errorf("Search query timed out for '%s'", query)
			return nil, fmt.Errorf("search query timed out: %w", err)
		}
		return nil, fmt.Errorf("failed to search stocks: %w", err)
	}
	defer rows.Close()

	var results []*stocksv1alpha1.Stock
	for rows.Next() {
		stock := &stocksv1alpha1.Stock{}
		if err := rows.Scan(
			&stock.PercentageShorted,
			&stock.ProductCode,
			&stock.Name,
			&stock.TotalProductInIssue,
			&stock.ReportedShortPositions,
			&stock.Industry,
			&stock.Tags,
			&stock.LogoUrl,
		); err != nil {
			log.Errorf("Failed to scan stock row for search '%s': %v", query, err)
			return nil, fmt.Errorf("failed to scan stock row: %w", err)
		}
		results = append(results, stock)
	}

	log.Debugf("Search completed for '%s': found %d stocks", query, len(results))
	return results, nil
}

func (s *postgresStore) GetSyncStatus(filter SyncStatusFilter) ([]*shortsv1alpha1.SyncRun, error) {
	// Build dynamic query with filters
	baseQuery := `
		SELECT 
			run_id, 
			started_at, 
			completed_at, 
			status, 
			error_message,
			shorts_records_updated, 
			prices_records_updated, 
			metrics_records_updated, 
			algolia_records_synced, 
			total_duration_seconds, 
			environment, 
			hostname,
			checkpoint_stocks_total,
			checkpoint_stocks_processed,
			checkpoint_stocks_successful,
			checkpoint_stocks_failed
		FROM sync_status
		WHERE 1=1
	`
	
	var args []interface{}
	argIndex := 1
	
	// Filter by environment if specified
	if filter.Environment != "" {
		baseQuery += fmt.Sprintf(" AND environment = $%d", argIndex)
		args = append(args, filter.Environment)
		argIndex++
	}
	
	// Exclude local/development hostnames if requested
	// Local runs typically have hostnames like "localhost", local machine names, or ".local" suffix
	if filter.ExcludeLocal {
		baseQuery += fmt.Sprintf(" AND hostname NOT LIKE '%%local%%' AND hostname NOT LIKE '%%.local' AND hostname IS NOT NULL AND hostname != ''")
	}
	
	baseQuery += " ORDER BY started_at DESC"
	
	// Apply limit
	limit := filter.Limit
	if limit <= 0 {
		limit = 10
	}
	if limit > 100 {
		limit = 100
	}
	baseQuery += fmt.Sprintf(" LIMIT $%d", argIndex)
	args = append(args, limit)

	rows, err := s.db.Query(context.Background(), baseQuery, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to query sync_status: %w", err)
	}
	defer rows.Close()

	var runs []*shortsv1alpha1.SyncRun
	for rows.Next() {
		run := &shortsv1alpha1.SyncRun{}
		var runID, status, errMsg, env, hostname sql.NullString
		var startedAt, completedAt sql.NullTime
		var shortsUpdated, pricesUpdated, metricsUpdated, algoliaSynced sql.NullInt32
		var duration sql.NullFloat64
		var checkpointStocksTotal, checkpointStocksProcessed, checkpointStocksSuccessful, checkpointStocksFailed sql.NullInt32

		if err := rows.Scan(
			&runID, &startedAt, &completedAt, &status, &errMsg,
			&shortsUpdated, &pricesUpdated, &metricsUpdated, &algoliaSynced,
			&duration, &env, &hostname,
			&checkpointStocksTotal, &checkpointStocksProcessed, &checkpointStocksSuccessful, &checkpointStocksFailed,
		); err != nil {
			return nil, fmt.Errorf("failed to scan sync_status row: %w", err)
		}

		run.RunId = runID.String
		if startedAt.Valid {
			run.StartedAt = startedAt.Time.Format(time.RFC3339)
		}
		if completedAt.Valid {
			run.CompletedAt = completedAt.Time.Format(time.RFC3339)
		}
		run.Status = status.String
		run.ErrorMessage = errMsg.String
		run.ShortsRecordsUpdated = shortsUpdated.Int32
		run.PricesRecordsUpdated = pricesUpdated.Int32
		run.MetricsRecordsUpdated = metricsUpdated.Int32
		run.AlgoliaRecordsSynced = algoliaSynced.Int32
		run.TotalDurationSeconds = duration.Float64
		run.Environment = env.String
		run.Hostname = hostname.String
		run.CheckpointStocksTotal = checkpointStocksTotal.Int32
		run.CheckpointStocksProcessed = checkpointStocksProcessed.Int32
		run.CheckpointStocksSuccessful = checkpointStocksSuccessful.Int32
		run.CheckpointStocksFailed = checkpointStocksFailed.Int32

		runs = append(runs, run)
	}

	return runs, nil
}

func (s *postgresStore) GetTopStocksForEnrichment(limit int32, priority shortsv1alpha1.EnrichmentPriority) ([]*shortsv1alpha1.StockEnrichmentCandidate, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if limit <= 0 {
		limit = 100
	}

	// Safety cap to avoid runaway queries (we can still batch all stocks).
	if limit > 10000 {
		limit = 10000
	}

	orderBy := "market_cap DESC"
	if priority == shortsv1alpha1.EnrichmentPriority_ENRICHMENT_PRIORITY_SHORT_POSITION {
		orderBy = "short_position_percent DESC"
	}

	whereClause := "WHERE m.stock_code IS NOT NULL"
	if priority == shortsv1alpha1.EnrichmentPriority_ENRICHMENT_PRIORITY_UNENRICHED {
		whereClause += " AND COALESCE(m.enrichment_status, 'pending') != 'completed'"
	}
	if priority == shortsv1alpha1.EnrichmentPriority_ENRICHMENT_PRIORITY_STALE {
		// Consider enrichment stale if older than 30 days or missing.
		whereClause += " AND (m.enrichment_date IS NULL OR m.enrichment_date < CURRENT_TIMESTAMP - INTERVAL '30 days')"
	}

	// Use latest shorts date for short_position_percent.
	query := fmt.Sprintf(`
		WITH latest AS (SELECT MAX("DATE") AS max_date FROM shorts)
		SELECT
			m.stock_code,
			COALESCE(m.company_name, '') as company_name,
			COALESCE(m.industry, '') as industry,
			COALESCE((m.key_metrics->>'market_cap')::double precision, 0) as market_cap,
			COALESCE(s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS", 0) * 100 as short_position_percent,
			COALESCE(m.enrichment_status, 'pending') as enrichment_status,
			m.enrichment_date as last_enriched
		FROM "company-metadata" m
		LEFT JOIN latest l ON true
		LEFT JOIN shorts s ON s."PRODUCT_CODE" = m.stock_code AND s."DATE" = l.max_date
		%s
		ORDER BY %s
		LIMIT $1
	`, whereClause, orderBy)

	rows, err := s.db.Query(ctx, query, limit)
	if err != nil {
		return nil, fmt.Errorf("failed to query enrichment candidates: %w", err)
	}
	defer rows.Close()

	var results []*shortsv1alpha1.StockEnrichmentCandidate
	for rows.Next() {
		var (
			stockCode             string
			companyName           string
			industry              string
			marketCap             float64
			shortPositionPercent  float64
			enrichmentStatus      string
			lastEnriched          pgtype.Timestamptz
		)
		if err := rows.Scan(
			&stockCode,
			&companyName,
			&industry,
			&marketCap,
			&shortPositionPercent,
			&enrichmentStatus,
			&lastEnriched,
		); err != nil {
			return nil, fmt.Errorf("failed to scan enrichment candidate: %w", err)
		}

		candidate := &shortsv1alpha1.StockEnrichmentCandidate{
			StockCode:           stockCode,
			CompanyName:         companyName,
			Industry:            industry,
			MarketCap:           marketCap,
			ShortPositionPercent: shortPositionPercent,
			EnrichmentStatus:    enrichmentStatus,
		}
		if lastEnriched.Status == pgtype.Present {
			candidate.LastEnriched = timestamppb.New(lastEnriched.Time)
		}
		results = append(results, candidate)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("failed to iterate enrichment candidates: %w", rows.Err())
	}

	// Set a simple priority score (higher is more important).
	for i := range results {
		results[i].PriorityScore = int32(len(results) - i)
	}

	return results, nil
}

func (s *postgresStore) UpdateLogoURLs(stockCode, logoGCSURL, logoIconGCSURL string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	query := `
		UPDATE "company-metadata"
		SET logo_gcs_url = $1, logo_icon_gcs_url = $2
		WHERE stock_code = $3
	`
	_, err := s.db.Exec(ctx, query, logoGCSURL, logoIconGCSURL, stockCode)
	if err != nil {
		return fmt.Errorf("failed to update logo URLs: %w", err)
	}
	return nil
}

func (s *postgresStore) UpdateLogoURLsWithSVG(stockCode, logoGCSURL, logoIconGCSURL, logoSVGGCSURL, logoSourceURL, logoFormat string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	query := `
		UPDATE "company-metadata"
		SET logo_gcs_url = $1, 
		    logo_icon_gcs_url = $2,
		    logo_svg_gcs_url = $3,
		    logo_source_url = $4,
		    logo_format = $5
		WHERE stock_code = $6
	`
	_, err := s.db.Exec(ctx, query, logoGCSURL, logoIconGCSURL, logoSVGGCSURL, logoSourceURL, logoFormat, stockCode)
	if err != nil {
		return fmt.Errorf("failed to update logo URLs with SVG: %w", err)
	}
	return nil
}

func (s *postgresStore) SavePendingEnrichment(enrichmentID, stockCode string, status shortsv1alpha1.EnrichmentStatus, data *shortsv1alpha1.EnrichmentData, quality *shortsv1alpha1.QualityScore) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if enrichmentID == "" {
		return "", fmt.Errorf("enrichmentID is required")
	}
	if stockCode == "" {
		return "", fmt.Errorf("stockCode is required")
	}
	if data == nil {
		return "", fmt.Errorf("enrichment data is required")
	}
	if quality == nil {
		return "", fmt.Errorf("quality score is required")
	}

	// Use protojson with EmitUnpopulated to ensure all fields are included
	// and UseProtoNames to match the proto field names
	marshaler := protojson.MarshalOptions{
		EmitUnpopulated: true,
		UseProtoNames:   true,
	}
	
	dataJSON, err := marshaler.Marshal(data)
	if err != nil {
		return "", fmt.Errorf("failed to marshal enrichment data: %w", err)
	}
	
	// Validate JSON is valid before inserting
	if len(dataJSON) == 0 || string(dataJSON) == "null" {
		return "", fmt.Errorf("enrichment data marshaled to empty or null JSON")
	}
	
	// Verify it's valid JSON by attempting to parse it
	// Use json.Valid() which is stricter and matches PostgreSQL's JSONB validation
	if !json.Valid(dataJSON) {
		return "", fmt.Errorf("enrichment data produced invalid JSON (not valid per json.Valid): %s", string(dataJSON))
	}
	var testData interface{}
	if err := json.Unmarshal(dataJSON, &testData); err != nil {
		return "", fmt.Errorf("enrichment data produced invalid JSON: %w (JSON: %s)", err, string(dataJSON))
	}
	
	qualityJSON, err := marshaler.Marshal(quality)
	if err != nil {
		return "", fmt.Errorf("failed to marshal quality score: %w", err)
	}
	
	// Validate quality JSON
	if len(qualityJSON) == 0 || string(qualityJSON) == "null" {
		return "", fmt.Errorf("quality score marshaled to empty or null JSON")
	}
	
	// Use json.Valid() which is stricter and matches PostgreSQL's JSONB validation
	if !json.Valid(qualityJSON) {
		return "", fmt.Errorf("quality score produced invalid JSON (not valid per json.Valid): %s", string(qualityJSON))
	}
	var testQuality interface{}
	if err := json.Unmarshal(qualityJSON, &testQuality); err != nil {
		return "", fmt.Errorf("quality score produced invalid JSON: %w (JSON: %s)", err, string(qualityJSON))
	}

	dbStatus := enrichmentStatusToDB(status)

	// If this is a new pending review, we want to see if one already exists for this stock.
	// If so, we'll use its enrichment_id to update it instead of creating a new one.
	// This prevents multiple pending reviews for the same stock.
	finalEnrichmentID := enrichmentID
	if dbStatus == "pending_review" {
		var existingID string
		checkQuery := `SELECT enrichment_id::text FROM "enrichment-pending" WHERE stock_code = $1 AND status = 'pending_review' LIMIT 1`
		err := s.db.QueryRow(ctx, checkQuery, stockCode).Scan(&existingID)
		if err == nil && existingID != "" {
			finalEnrichmentID = existingID
		}
	}

	query := `
		INSERT INTO "enrichment-pending" (
			enrichment_id,
			stock_code,
			enrichment_data,
			quality_score,
			status
		) VALUES ($1::uuid, $2, $3::jsonb, $4::jsonb, $5)
		ON CONFLICT (enrichment_id) DO UPDATE SET
			stock_code = EXCLUDED.stock_code,
			enrichment_data = EXCLUDED.enrichment_data,
			quality_score = EXCLUDED.quality_score,
			status = EXCLUDED.status,
			created_at = CURRENT_TIMESTAMP,
			reviewed_at = NULL,
			reviewed_by = NULL,
			review_notes = NULL
	`

	// Convert []byte to string for PostgreSQL - pgx handles both but string is more explicit
	// This ensures proper encoding and avoids any byte-level issues
	dataJSONStr := string(dataJSON)
	qualityJSONStr := string(qualityJSON)
	
	// Log the JSON being inserted for debugging (truncated to avoid huge logs)
	dataJSONPreview := dataJSONStr
	qualityJSONPreview := qualityJSONStr
	if len(dataJSONPreview) > 500 {
		dataJSONPreview = dataJSONPreview[:500] + "... (truncated)"
	}
	if len(qualityJSONPreview) > 500 {
		qualityJSONPreview = qualityJSONPreview[:500] + "... (truncated)"
	}
	log.Debugf("Saving enrichment for %s: dataJSON length=%d, qualityJSON length=%d", stockCode, len(dataJSON), len(qualityJSON))
	log.Debugf("Data JSON (first 500 chars): %s", dataJSONPreview)
	log.Debugf("Quality JSON (first 500 chars): %s", qualityJSONPreview)
	
	_, err = s.db.Exec(ctx, query, finalEnrichmentID, stockCode, dataJSONStr, qualityJSONStr, dbStatus)
	if err != nil {
		// Include JSON snippets in error for debugging
		return "", fmt.Errorf("failed to save pending enrichment: %w (dataJSON length: %d, qualityJSON length: %d, dataJSON preview: %s)", 
			err, len(dataJSON), len(qualityJSON), dataJSONStr)
	}
	return finalEnrichmentID, nil
}

func (s *postgresStore) ListPendingEnrichments(limit int32, offset int32) ([]*shortsv1alpha1.PendingEnrichmentSummary, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if limit <= 0 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}
	if offset < 0 {
		offset = 0
	}

	query := `
		SELECT
			enrichment_id::text,
			stock_code,
			status,
			created_at,
			quality_score
		FROM "enrichment-pending"
		WHERE status = 'pending_review'
		ORDER BY created_at DESC
		LIMIT $1 OFFSET $2
	`

	rows, err := s.db.Query(ctx, query, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("failed to list pending enrichments: %w", err)
	}
	defer rows.Close()

	var results []*shortsv1alpha1.PendingEnrichmentSummary
	for rows.Next() {
		var (
			enrichmentID string
			stockCode    string
			status       string
			createdAt    pgtype.Timestamptz
			qualityJSON  []byte
		)
		if err := rows.Scan(&enrichmentID, &stockCode, &status, &createdAt, &qualityJSON); err != nil {
			return nil, fmt.Errorf("failed to scan pending enrichment summary: %w", err)
		}

		quality := &shortsv1alpha1.QualityScore{}
		if !isEmptyJSON(qualityJSON) {
			if err := protojson.Unmarshal(qualityJSON, quality); err != nil {
				return nil, fmt.Errorf("failed to unmarshal quality score: %w", err)
			}
		}

		summary := &shortsv1alpha1.PendingEnrichmentSummary{
			EnrichmentId: enrichmentID,
			StockCode:    stockCode,
			Status:       enrichmentStatusFromDB(status),
			QualityScore: quality,
		}
		if createdAt.Status == pgtype.Present {
			summary.CreatedAt = timestamppb.New(createdAt.Time)
		}
		results = append(results, summary)
	}

	if rows.Err() != nil {
		return nil, fmt.Errorf("failed to iterate pending enrichments: %w", rows.Err())
	}
	return results, nil
}

func (s *postgresStore) GetPendingEnrichment(enrichmentID string) (*shortsv1alpha1.PendingEnrichment, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if enrichmentID == "" {
		return nil, fmt.Errorf("enrichmentID is required")
	}

	query := `
		SELECT
			enrichment_id::text,
			stock_code,
			status,
			enrichment_data,
			quality_score,
			created_at,
			reviewed_at,
			reviewed_by,
			review_notes
		FROM "enrichment-pending"
		WHERE enrichment_id = $1::uuid
		LIMIT 1
	`

	var (
		id          string
		stockCode   string
		status      string
		dataJSON    []byte
		qualityJSON []byte
		createdAt   pgtype.Timestamptz
		reviewedAt  pgtype.Timestamptz
		reviewedBy  sql.NullString
		reviewNotes sql.NullString
	)

	if err := s.db.QueryRow(ctx, query, enrichmentID).Scan(
		&id,
		&stockCode,
		&status,
		&dataJSON,
		&qualityJSON,
		&createdAt,
		&reviewedAt,
		&reviewedBy,
		&reviewNotes,
	); err != nil {
		return nil, fmt.Errorf("failed to get pending enrichment: %w", err)
	}

	data := &shortsv1alpha1.EnrichmentData{}
	if !isEmptyJSON(dataJSON) {
		if err := protojson.Unmarshal(dataJSON, data); err != nil {
			return nil, fmt.Errorf("failed to unmarshal enrichment data: %w", err)
		}
	}

	quality := &shortsv1alpha1.QualityScore{}
	if !isEmptyJSON(qualityJSON) {
		if err := protojson.Unmarshal(qualityJSON, quality); err != nil {
			return nil, fmt.Errorf("failed to unmarshal quality score: %w", err)
		}
	}

	pending := &shortsv1alpha1.PendingEnrichment{
		EnrichmentId: id,
		StockCode:    stockCode,
		Status:       enrichmentStatusFromDB(status),
		Data:         data,
		QualityScore: quality,
		ReviewedBy:   reviewedBy.String,
		ReviewNotes:  reviewNotes.String,
	}
	if createdAt.Status == pgtype.Present {
		pending.CreatedAt = timestamppb.New(createdAt.Time)
	}
	if reviewedAt.Status == pgtype.Present {
		pending.ReviewedAt = timestamppb.New(reviewedAt.Time)
	}

	return pending, nil
}

func (s *postgresStore) GetPendingEnrichmentByStockCode(stockCode string) (*shortsv1alpha1.PendingEnrichmentSummary, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if stockCode == "" {
		return nil, fmt.Errorf("stockCode is required")
	}

	query := `
		SELECT
			enrichment_id::text,
			stock_code,
			status,
			created_at,
			quality_score
		FROM "enrichment-pending"
		WHERE stock_code = $1 AND status = 'pending_review'
		ORDER BY created_at DESC
		LIMIT 1
	`

	var (
		enrichmentID string
		dbStockCode  string
		status       string
		createdAt    pgtype.Timestamptz
		qualityJSON  []byte
	)

	err := s.db.QueryRow(ctx, query, stockCode).Scan(
		&enrichmentID,
		&dbStockCode,
		&status,
		&createdAt,
		&qualityJSON,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) || errors.Is(err, pgx.ErrNoRows) {
			return nil, nil // No pending enrichment found
		}
		return nil, fmt.Errorf("failed to get pending enrichment by stock code: %w", err)
	}

	quality := &shortsv1alpha1.QualityScore{}
	if !isEmptyJSON(qualityJSON) {
		if err := protojson.Unmarshal(qualityJSON, quality); err != nil {
			return nil, fmt.Errorf("failed to unmarshal quality score: %w", err)
		}
	}

	summary := &shortsv1alpha1.PendingEnrichmentSummary{
		EnrichmentId: enrichmentID,
		StockCode:    dbStockCode,
		Status:       enrichmentStatusFromDB(status),
		QualityScore: quality,
	}
	if createdAt.Status == pgtype.Present {
		summary.CreatedAt = timestamppb.New(createdAt.Time)
	}

	return summary, nil
}

func (s *postgresStore) ReviewEnrichment(enrichmentID string, approve bool, reviewedBy, reviewNotes string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if enrichmentID == "" {
		return fmt.Errorf("enrichmentID is required")
	}

	newStatus := "rejected"
	if approve {
		newStatus = "approved"
	}

	query := `
		UPDATE "enrichment-pending"
		SET
			status = $2,
			reviewed_at = CURRENT_TIMESTAMP,
			reviewed_by = $3,
			review_notes = $4
		WHERE enrichment_id = $1::uuid
	`
	result, err := s.db.Exec(ctx, query, enrichmentID, newStatus, reviewedBy, reviewNotes)
	if err != nil {
		return fmt.Errorf("failed to review enrichment: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("pending enrichment not found: %s", enrichmentID)
	}
	return nil
}

func (s *postgresStore) ApplyEnrichment(stockCode string, data *shortsv1alpha1.EnrichmentData) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if stockCode == "" {
		return fmt.Errorf("stockCode is required")
	}
	if data == nil {
		return fmt.Errorf("enrichment data is required")
	}

	// Convert nested proto messages to the DB JSON shape expected by existing parsers.
	keyPeople := make([]dbPerson, 0, len(data.KeyPeople))
	for _, person := range data.KeyPeople {
		if person == nil {
			continue
		}
		keyPeople = append(keyPeople, dbPerson{
			Name: person.Name,
			Role: person.Role,
			Bio:  person.Bio,
		})
	}
	keyPeopleJSON, err := json.Marshal(keyPeople)
	if err != nil {
		return fmt.Errorf("failed to marshal key_people: %w", err)
	}
	log.Debugf("ApplyEnrichment %s: key_people JSON (%d bytes): %s", stockCode, len(keyPeopleJSON), string(keyPeopleJSON))

	reports := make([]dbFinancialReport, 0, len(data.FinancialReports))
	for _, report := range data.FinancialReports {
		if report == nil {
			continue
		}
		reports = append(reports, dbFinancialReport{
			URL:    report.Url,
			Title:  report.Title,
			Type:   report.Type,
			Date:   report.Date,
			Source: report.Source,
			GCSURL: report.GcsUrl,
		})
	}
	reportsJSON, err := json.Marshal(reports)
	if err != nil {
		return fmt.Errorf("failed to marshal financial_reports: %w", err)
	}
	log.Debugf("ApplyEnrichment %s: financial_reports JSON (%d bytes)", stockCode, len(reportsJSON))

	var links dbSocialMediaLinks
	if data.SocialMediaLinks != nil {
		if data.SocialMediaLinks.Twitter != "" {
			v := data.SocialMediaLinks.Twitter
			links.Twitter = &v
		}
		if data.SocialMediaLinks.Linkedin != "" {
			v := data.SocialMediaLinks.Linkedin
			links.LinkedIn = &v
		}
		if data.SocialMediaLinks.Facebook != "" {
			v := data.SocialMediaLinks.Facebook
			links.Facebook = &v
		}
		if data.SocialMediaLinks.Youtube != "" {
			v := data.SocialMediaLinks.Youtube
			links.YouTube = &v
		}
		if data.SocialMediaLinks.Website != "" {
			v := data.SocialMediaLinks.Website
			links.Website = &v
		}
	}
	socialLinksJSON, err := json.Marshal(links)
	if err != nil {
		return fmt.Errorf("failed to marshal social_media_links: %w", err)
	}
	log.Debugf("ApplyEnrichment %s: social_media_links JSON (%d bytes): %s", stockCode, len(socialLinksJSON), string(socialLinksJSON))
	log.Debugf("ApplyEnrichment %s: tags=%v, risk_factors=%v", stockCode, data.Tags, data.RiskFactors)

	enhancedSummary := sql.NullString{String: data.EnhancedSummary, Valid: data.EnhancedSummary != ""}
	companyHistory := sql.NullString{String: data.CompanyHistory, Valid: data.CompanyHistory != ""}
	competitiveAdvantages := sql.NullString{String: data.CompetitiveAdvantages, Valid: data.CompetitiveAdvantages != ""}
	recentDevelopments := sql.NullString{String: data.RecentDevelopments, Valid: data.RecentDevelopments != ""}

	// Convert risk_factors []string to JSON string for TEXT column storage
	var riskFactorsJSON sql.NullString
	if len(data.RiskFactors) > 0 {
		riskFactorsBytes, err := json.Marshal(data.RiskFactors)
		if err != nil {
			return fmt.Errorf("failed to marshal risk_factors: %w", err)
		}
		riskFactorsJSON = sql.NullString{String: string(riskFactorsBytes), Valid: true}
	}

	// Handle logo URLs (only update if provided)
	logoGcsUrl := sql.NullString{String: data.LogoGcsUrl, Valid: data.LogoGcsUrl != ""}
	logoIconGcsUrl := sql.NullString{String: data.LogoIconGcsUrl, Valid: data.LogoIconGcsUrl != ""}
	logoSvgGcsUrl := sql.NullString{String: data.LogoSvgGcsUrl, Valid: data.LogoSvgGcsUrl != ""}
	logoSourceUrl := sql.NullString{String: data.LogoSourceUrl, Valid: data.LogoSourceUrl != ""}
	logoFormat := sql.NullString{String: data.LogoFormat, Valid: data.LogoFormat != ""}

	// Handle discovered website (only update if provided and current website is empty)
	discoveredWebsite := sql.NullString{String: data.DiscoveredWebsite, Valid: data.DiscoveredWebsite != ""}
	if discoveredWebsite.Valid {
		log.Infof("ApplyEnrichment %s: discovered website to apply: %s", stockCode, data.DiscoveredWebsite)
	}

	query := `
		UPDATE "company-metadata"
		SET
			tags = $2,
			enhanced_summary = $3,
			company_history = $4,
			key_people = $5::jsonb,
			financial_reports = $6::jsonb,
			competitive_advantages = $7,
			risk_factors = $8,
			recent_developments = $9,
			social_media_links = $10::jsonb,
			enrichment_status = 'completed',
			enrichment_date = CURRENT_TIMESTAMP,
			enrichment_error = NULL,
			-- Update logo URLs if provided (COALESCE keeps existing value if new is NULL)
			logo_gcs_url = COALESCE($11, logo_gcs_url),
			logo_icon_gcs_url = COALESCE($12, logo_icon_gcs_url),
			logo_svg_gcs_url = COALESCE($13, logo_svg_gcs_url),
			logo_source_url = COALESCE($14, logo_source_url),
			logo_format = COALESCE($15, logo_format),
			-- Also update the legacy gcsUrl field for backward compatibility
			"gcsUrl" = COALESCE($11, "gcsUrl"),
			-- Update website if discovered and current is empty (don't overwrite existing)
			website = CASE 
				WHEN (website IS NULL OR website = '') AND $16::text IS NOT NULL AND $16::text != ''
				THEN $16::text 
				ELSE website 
			END,
			-- Also populate the base summary field with enhanced_summary if summary is empty
			-- This ensures the "About" section always has content after enrichment
			summary = CASE 
				WHEN (summary IS NULL OR summary = '') AND $3::text IS NOT NULL AND $3::text != ''
				THEN $3::text 
				ELSE summary 
			END
		WHERE stock_code = $1
	`

	// Convert []byte to string for PostgreSQL - pgx handles both but string is more explicit
	// This ensures proper encoding and avoids any byte-level issues with jsonb columns
	keyPeopleJSONStr := string(keyPeopleJSON)
	reportsJSONStr := string(reportsJSON)
	socialLinksJSONStr := string(socialLinksJSON)

	result, err := s.db.Exec(
		ctx,
		query,
		stockCode,
		data.Tags,
		enhancedSummary,
		companyHistory,
		keyPeopleJSONStr,
		reportsJSONStr,
		competitiveAdvantages,
		riskFactorsJSON,
		recentDevelopments,
		socialLinksJSONStr,
		logoGcsUrl,
		logoIconGcsUrl,
		logoSvgGcsUrl,
		logoSourceUrl,
		logoFormat,
		discoveredWebsite,
	)
	if err != nil {
		return fmt.Errorf("failed to apply enrichment: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("stock not found: %s", stockCode)
	}
	return nil
}

func enrichmentStatusToDB(status shortsv1alpha1.EnrichmentStatus) string {
	switch status {
	case shortsv1alpha1.EnrichmentStatus_ENRICHMENT_STATUS_REJECTED:
		return "rejected"
	case shortsv1alpha1.EnrichmentStatus_ENRICHMENT_STATUS_COMPLETED:
		return "approved"
	case shortsv1alpha1.EnrichmentStatus_ENRICHMENT_STATUS_PENDING_REVIEW:
		return "pending_review"
	default:
		return "pending_review"
	}
}

func enrichmentStatusFromDB(status string) shortsv1alpha1.EnrichmentStatus {
	switch strings.ToLower(status) {
	case "pending_review":
		return shortsv1alpha1.EnrichmentStatus_ENRICHMENT_STATUS_PENDING_REVIEW
	case "approved":
		return shortsv1alpha1.EnrichmentStatus_ENRICHMENT_STATUS_COMPLETED
	case "rejected":
		return shortsv1alpha1.EnrichmentStatus_ENRICHMENT_STATUS_REJECTED
	default:
		return shortsv1alpha1.EnrichmentStatus_ENRICHMENT_STATUS_UNSPECIFIED
	}
}

func (s *postgresStore) CreateEnrichmentJob(stockCode string, force bool) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	query := `
		INSERT INTO "enrichment-jobs" (
			stock_code,
			status,
			force
		) VALUES ($1, 'queued', $2)
		RETURNING job_id::text
	`

	var jobID string
	err := s.db.QueryRow(ctx, query, stockCode, force).Scan(&jobID)
	if err != nil {
		return "", fmt.Errorf("failed to create enrichment job: %w", err)
	}

	return jobID, nil
}

func (s *postgresStore) GetActiveEnrichmentJobByStockCode(stockCode string) (*shortsv1alpha1.EnrichmentJob, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	query := `
		SELECT
			job_id::text,
			stock_code,
			status,
			priority,
			force,
			created_at,
			started_at,
			completed_at,
			error_message,
			enrichment_id::text
		FROM "enrichment-jobs"
		WHERE stock_code = $1 AND status IN ('queued', 'processing')
		ORDER BY created_at DESC
		LIMIT 1
	`

	var (
		dbJobID      string
		dbStockCode  string
		status       string
		priority     int32
		force        bool
		createdAt    pgtype.Timestamptz
		startedAt    pgtype.Timestamptz
		completedAt  pgtype.Timestamptz
		errorMessage sql.NullString
		enrichmentID sql.NullString
	)

	err := s.db.QueryRow(ctx, query, stockCode).Scan(
		&dbJobID,
		&dbStockCode,
		&status,
		&priority,
		&force,
		&createdAt,
		&startedAt,
		&completedAt,
		&errorMessage,
		&enrichmentID,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil // No active job
		}
		return nil, fmt.Errorf("failed to get active enrichment job: %w", err)
	}

	job := &shortsv1alpha1.EnrichmentJob{
		JobId:     dbJobID,
		StockCode: dbStockCode,
		Status:    enrichmentJobStatusFromDB(status),
		Priority:  priority,
		Force:     force,
	}

	if createdAt.Status == pgtype.Present {
		job.CreatedAt = timestamppb.New(createdAt.Time)
	}
	if startedAt.Status == pgtype.Present {
		job.StartedAt = timestamppb.New(startedAt.Time)
	}
	if completedAt.Status == pgtype.Present {
		job.CompletedAt = timestamppb.New(completedAt.Time)
	}
	if errorMessage.Valid {
		job.ErrorMessage = errorMessage.String
	}
	if enrichmentID.Valid {
		job.EnrichmentId = enrichmentID.String
	}

	return job, nil
}

func (s *postgresStore) GetEnrichmentJob(jobID string) (*shortsv1alpha1.EnrichmentJob, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	query := `
		SELECT
			job_id::text,
			stock_code,
			status,
			priority,
			force,
			created_at,
			started_at,
			completed_at,
			error_message,
			enrichment_id::text
		FROM "enrichment-jobs"
		WHERE job_id = $1::uuid
		LIMIT 1
	`

	var (
		dbJobID        string
		stockCode      string
		status         string
		priority       int32
		force          bool
		createdAt      pgtype.Timestamptz
		startedAt      pgtype.Timestamptz
		completedAt    pgtype.Timestamptz
		errorMessage   sql.NullString
		enrichmentID   sql.NullString
	)

	err := s.db.QueryRow(ctx, query, jobID).Scan(
		&dbJobID,
		&stockCode,
		&status,
		&priority,
		&force,
		&createdAt,
		&startedAt,
		&completedAt,
		&errorMessage,
		&enrichmentID,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("enrichment job not found: %s", jobID)
		}
		return nil, fmt.Errorf("failed to get enrichment job: %w", err)
	}

	job := &shortsv1alpha1.EnrichmentJob{
		JobId:     dbJobID,
		StockCode: stockCode,
		Status:    enrichmentJobStatusFromDB(status),
		Priority:  priority,
		Force:     force,
	}

	if createdAt.Status == pgtype.Present {
		job.CreatedAt = timestamppb.New(createdAt.Time)
	}
	if startedAt.Status == pgtype.Present {
		job.StartedAt = timestamppb.New(startedAt.Time)
	}
	if completedAt.Status == pgtype.Present {
		job.CompletedAt = timestamppb.New(completedAt.Time)
	}
	if errorMessage.Valid {
		job.ErrorMessage = errorMessage.String
	}
	if enrichmentID.Valid {
		job.EnrichmentId = enrichmentID.String
	}

	return job, nil
}

// UpdateEnrichmentJobStatus updates the status of an enrichment job with retry logic.
// This function will retry up to 5 times with exponential backoff to ensure the status
// is always updated, preventing jobs from getting stuck in processing.
func (s *postgresStore) UpdateEnrichmentJobStatus(jobID string, status shortsv1alpha1.EnrichmentJobStatus, enrichmentID *string, errorMsg *string) error {
	const maxRetries = 5
	const initialBackoff = 100 * time.Millisecond
	const maxBackoff = 5 * time.Second

	dbStatus := enrichmentJobStatusToDB(status)
	now := time.Now()

	var query string
	var args []interface{}

	switch status {
	case shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_PROCESSING:
		query = `
			UPDATE "enrichment-jobs"
			SET status = $1, started_at = $2
			WHERE job_id = $3::uuid
		`
		args = []interface{}{dbStatus, now, jobID}
	case shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_COMPLETED:
		// Handle enrichment_id - use NULL if empty, otherwise cast to UUID
		if enrichmentID != nil && *enrichmentID != "" {
			query = `
				UPDATE "enrichment-jobs"
				SET status = $1, completed_at = $2, enrichment_id = $3::uuid
				WHERE job_id = $4::uuid
			`
			args = []interface{}{dbStatus, now, *enrichmentID, jobID}
		} else {
			query = `
				UPDATE "enrichment-jobs"
				SET status = $1, completed_at = $2
				WHERE job_id = $3::uuid
			`
			args = []interface{}{dbStatus, now, jobID}
		}
	case shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_FAILED:
		query = `
			UPDATE "enrichment-jobs"
			SET status = $1, completed_at = $2, error_message = $3
			WHERE job_id = $4::uuid
		`
		errMsg := ""
		if errorMsg != nil {
			errMsg = *errorMsg
		}
		args = []interface{}{dbStatus, now, errMsg, jobID}
	default:
		query = `
			UPDATE "enrichment-jobs"
			SET status = $1
			WHERE job_id = $2::uuid
		`
		args = []interface{}{dbStatus, jobID}
	}

	var lastErr error
	backoff := initialBackoff

	for attempt := 0; attempt < maxRetries; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		
		_, err := s.db.Exec(ctx, query, args...)
		cancel()
		
		if err == nil {
			// Success - status updated
			return nil
		}

		lastErr = err
		
		// Don't retry on the last attempt
		if attempt < maxRetries-1 {
			// Exponential backoff with jitter
			time.Sleep(backoff)
			backoff = time.Duration(float64(backoff) * 2.0)
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
			
			log.Warnf("Failed to update enrichment job %s status to %s (attempt %d/%d), retrying: %v", 
				jobID, dbStatus, attempt+1, maxRetries, err)
		}
	}

	// All retries failed - this is a critical error
	return fmt.Errorf("failed to update enrichment job status after %d attempts: %w", maxRetries, lastErr)
}

func (s *postgresStore) ListEnrichmentJobs(limit, offset int32, status *shortsv1alpha1.EnrichmentJobStatus) ([]*shortsv1alpha1.EnrichmentJob, int32, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if limit <= 0 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}
	if offset < 0 {
		offset = 0
	}

	baseQuery := `
		SELECT
			job_id::text,
			stock_code,
			status,
			priority,
			force,
			created_at,
			started_at,
			completed_at,
			error_message,
			enrichment_id::text
		FROM "enrichment-jobs"
	`
	whereClause := ""
	args := []interface{}{limit, offset}
	argIdx := 3

	if status != nil {
		whereClause = fmt.Sprintf(" WHERE status = $%d", argIdx)
		args = append(args, enrichmentJobStatusToDB(*status))
		// argIdx is only used for the WHERE clause formatting above
	}

	query := baseQuery + whereClause + `
		ORDER BY created_at DESC
		LIMIT $1 OFFSET $2
	`

	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to list enrichment jobs: %w", err)
	}
	defer rows.Close()

	var jobs []*shortsv1alpha1.EnrichmentJob
	for rows.Next() {
		var (
			jobID        string
			stockCode    string
			dbStatus     string
			priority     int32
			force        bool
			createdAt    pgtype.Timestamptz
			startedAt    pgtype.Timestamptz
			completedAt  pgtype.Timestamptz
			errorMessage sql.NullString
			enrichmentID sql.NullString
		)

		err := rows.Scan(
			&jobID,
			&stockCode,
			&dbStatus,
			&priority,
			&force,
			&createdAt,
			&startedAt,
			&completedAt,
			&errorMessage,
			&enrichmentID,
		)
		if err != nil {
			return nil, 0, fmt.Errorf("failed to scan enrichment job: %w", err)
		}

		job := &shortsv1alpha1.EnrichmentJob{
			JobId:     jobID,
			StockCode: stockCode,
			Status:    enrichmentJobStatusFromDB(dbStatus),
			Priority:  priority,
			Force:     force,
		}

		if createdAt.Status == pgtype.Present {
			job.CreatedAt = timestamppb.New(createdAt.Time)
		}
		if startedAt.Status == pgtype.Present {
			job.StartedAt = timestamppb.New(startedAt.Time)
		}
		if completedAt.Status == pgtype.Present {
			job.CompletedAt = timestamppb.New(completedAt.Time)
		}
		if errorMessage.Valid {
			job.ErrorMessage = errorMessage.String
		}
		if enrichmentID.Valid {
			job.EnrichmentId = enrichmentID.String
		}

		jobs = append(jobs, job)
	}

	// Get total count
	countQuery := `SELECT COUNT(*) FROM "enrichment-jobs"` + whereClause
	countArgs := args[2:] // Skip limit and offset
	var totalCount int32
	if len(countArgs) > 0 {
		err = s.db.QueryRow(ctx, countQuery, countArgs...).Scan(&totalCount)
	} else {
		err = s.db.QueryRow(ctx, countQuery).Scan(&totalCount)
	}
	if err != nil {
		return jobs, int32(len(jobs)), nil // Return partial count if query fails
	}

	return jobs, totalCount, nil
}

func (s *postgresStore) ResetStuckJobs(stuckThresholdMinutes int) (int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Reset jobs that have been in "processing" status for more than the threshold
	query := `
		UPDATE "enrichment-jobs"
		SET status = 'queued', started_at = NULL, error_message = $1
		WHERE status = 'processing'
		  AND started_at IS NOT NULL
		  AND started_at < NOW() - INTERVAL '1 minute' * $2
		RETURNING job_id
	`
	errorMsg := fmt.Sprintf("Job was stuck in processing for > %d minutes, reset to queued", stuckThresholdMinutes)
	
	rows, err := s.db.Query(ctx, query, errorMsg, stuckThresholdMinutes)
	if err != nil {
		return 0, fmt.Errorf("failed to reset stuck jobs: %w", err)
	}
	defer rows.Close()

	count := 0
	for rows.Next() {
		count++
	}
	
	if count > 0 {
		log.Infof("Reset %d stuck enrichment job(s) back to queued", count)
	}
	
	return count, nil
}

func (s *postgresStore) CleanupOldCompletedJobs(keepPerStock int) (int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Delete old completed jobs, keeping only the keepPerStock most recent per stock
	// Uses a window function to identify which jobs to keep
	query := `
		WITH ranked_jobs AS (
			SELECT 
				job_id,
				ROW_NUMBER() OVER (PARTITION BY stock_code ORDER BY completed_at DESC NULLS LAST, created_at DESC) as rn
			FROM "enrichment-jobs"
			WHERE status = 'completed'
		)
		DELETE FROM "enrichment-jobs"
		WHERE job_id IN (
			SELECT job_id FROM ranked_jobs WHERE rn > $1
		)
		RETURNING job_id
	`
	
	rows, err := s.db.Query(ctx, query, keepPerStock)
	if err != nil {
		return 0, fmt.Errorf("failed to cleanup old completed jobs: %w", err)
	}
	defer rows.Close()

	count := 0
	for rows.Next() {
		count++
	}
	
	if count > 0 {
		log.Infof("Cleaned up %d old completed enrichment job(s) (kept %d most recent per stock)", count, keepPerStock)
	}
	
	return count, nil
}

func enrichmentJobStatusToDB(status shortsv1alpha1.EnrichmentJobStatus) string {
	switch status {
	case shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_QUEUED:
		return "queued"
	case shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_PROCESSING:
		return "processing"
	case shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_COMPLETED:
		return "completed"
	case shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_FAILED:
		return "failed"
	case shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_CANCELLED:
		return "cancelled"
	default:
		return "queued"
	}
}

func enrichmentJobStatusFromDB(status string) shortsv1alpha1.EnrichmentJobStatus {
	switch status {
	case "queued":
		return shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_QUEUED
	case "processing":
		return shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_PROCESSING
	case "completed":
		return shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_COMPLETED
	case "failed":
		return shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_FAILED
	case "cancelled":
		return shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_CANCELLED
	default:
		return shortsv1alpha1.EnrichmentJobStatus_ENRICHMENT_JOB_STATUS_UNSPECIFIED
	}
}

// GetAPISubscription retrieves the API subscription status for a user
func (s *postgresStore) GetAPISubscription(userID string) (*APISubscription, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	query := `
		SELECT user_id, user_email, COALESCE(stripe_customer_id, ''), COALESCE(stripe_subscription_id, ''),
		       status, tier, current_period_start::text, current_period_end::text, cancel_at_period_end
		FROM api_subscriptions
		WHERE user_id = $1
	`

	var sub APISubscription
	var periodStart, periodEnd *string

	err := s.db.QueryRow(ctx, query, userID).Scan(
		&sub.UserID,
		&sub.UserEmail,
		&sub.StripeCustomerID,
		&sub.StripeSubscriptionID,
		&sub.Status,
		&sub.Tier,
		&periodStart,
		&periodEnd,
		&sub.CancelAtPeriodEnd,
	)

	if err != nil {
		if err.Error() == "no rows in result set" {
			// No subscription found, return nil (free tier)
			return nil, nil
		}
		return nil, fmt.Errorf("failed to get subscription: %w", err)
	}

	sub.CurrentPeriodStart = periodStart
	sub.CurrentPeriodEnd = periodEnd
	return &sub, nil
}

func (s *postgresStore) GetAPISubscriptionByCustomer(stripeCustomerID string) (*APISubscription, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	query := `
		SELECT user_id, user_email, COALESCE(stripe_customer_id, ''), COALESCE(stripe_subscription_id, ''),
		       status, tier, current_period_start::text, current_period_end::text, cancel_at_period_end
		FROM api_subscriptions
		WHERE stripe_customer_id = $1
	`

	var sub APISubscription
	var periodStart, periodEnd *string

	err := s.db.QueryRow(ctx, query, stripeCustomerID).Scan(
		&sub.UserID,
		&sub.UserEmail,
		&sub.StripeCustomerID,
		&sub.StripeSubscriptionID,
		&sub.Status,
		&sub.Tier,
		&periodStart,
		&periodEnd,
		&sub.CancelAtPeriodEnd,
	)

	if err != nil {
		if err.Error() == "no rows in result set" {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to get subscription by customer: %w", err)
	}

	sub.CurrentPeriodStart = periodStart
	sub.CurrentPeriodEnd = periodEnd
	return &sub, nil
}

func (s *postgresStore) UpsertAPISubscription(sub *APISubscription) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// First, delete any existing subscription with the same stripe_customer_id but different user_id.
	// This handles the case where a customer ID was previously associated with a different user
	// (e.g., during testing or account migration).
	if sub.StripeCustomerID != "" {
		deleteQuery := `
			DELETE FROM api_subscriptions 
			WHERE stripe_customer_id = $1 AND user_id != $2
		`
		_, _ = s.db.Exec(ctx, deleteQuery, sub.StripeCustomerID, sub.UserID)
	}

	query := `
		INSERT INTO api_subscriptions (
			user_id, user_email, stripe_customer_id, stripe_subscription_id,
			status, tier, current_period_start, current_period_end, cancel_at_period_end
		) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9)
		ON CONFLICT (user_id) DO UPDATE SET
			stripe_customer_id = EXCLUDED.stripe_customer_id,
			stripe_subscription_id = EXCLUDED.stripe_subscription_id,
			status = EXCLUDED.status,
			tier = EXCLUDED.tier,
			current_period_start = EXCLUDED.current_period_start,
			current_period_end = EXCLUDED.current_period_end,
			cancel_at_period_end = EXCLUDED.cancel_at_period_end,
			updated_at = CURRENT_TIMESTAMP
	`

	_, err := s.db.Exec(ctx, query,
		sub.UserID,
		sub.UserEmail,
		sub.StripeCustomerID,
		sub.StripeSubscriptionID,
		sub.Status,
		sub.Tier,
		sub.CurrentPeriodStart,
		sub.CurrentPeriodEnd,
		sub.CancelAtPeriodEnd,
	)

	if err != nil {
		return fmt.Errorf("failed to upsert subscription: %w", err)
	}

	return nil
}

func (s *postgresStore) UpdateAPISubscriptionByCustomer(stripeCustomerID string, update *APISubscriptionUpdate) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Build dynamic update query based on which fields are set
	setParts := []string{"updated_at = CURRENT_TIMESTAMP"}
	args := []interface{}{}
	argNum := 1

	if update.Status != nil {
		setParts = append(setParts, fmt.Sprintf("status = $%d", argNum))
		args = append(args, *update.Status)
		argNum++
	}
	if update.Tier != nil {
		setParts = append(setParts, fmt.Sprintf("tier = $%d", argNum))
		args = append(args, *update.Tier)
		argNum++
	}
	if update.CurrentPeriodStart != nil {
		setParts = append(setParts, fmt.Sprintf("current_period_start = $%d::timestamptz", argNum))
		args = append(args, *update.CurrentPeriodStart)
		argNum++
	}
	if update.CurrentPeriodEnd != nil {
		setParts = append(setParts, fmt.Sprintf("current_period_end = $%d::timestamptz", argNum))
		args = append(args, *update.CurrentPeriodEnd)
		argNum++
	}
	if update.CancelAtPeriodEnd != nil {
		setParts = append(setParts, fmt.Sprintf("cancel_at_period_end = $%d", argNum))
		args = append(args, *update.CancelAtPeriodEnd)
		argNum++
	}

	// Add customer ID as the last argument
	args = append(args, stripeCustomerID)

	query := fmt.Sprintf(`
		UPDATE api_subscriptions
		SET %s
		WHERE stripe_customer_id = $%d
	`, strings.Join(setParts, ", "), argNum)

	result, err := s.db.Exec(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("failed to update subscription: %w", err)
	}

	// Don't treat "no rows affected" as an error - the subscription record
	// might not exist yet (checkout.session.completed will create it)
	if result.RowsAffected() == 0 {
		// Log but don't fail - this is expected when subscription events arrive
		// before the checkout completion creates the initial record
		return nil
	}

	return nil
}

