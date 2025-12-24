package shorts

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/jackc/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/types/known/timestamppb"
)

const (
	companyMetadataTableName  = "company-metadata"
	stockDetailsQueryTemplate = `
SELECT 
	stock_code,
	company_name,
	industry,
	address,
	COALESCE(summary, '') as summary,
	details,
	website,
	%s,
	COALESCE(tags, ARRAY[]::text[]) as tags,
	enhanced_summary,
	company_history,
	COALESCE(key_people, '[]'::jsonb) as key_people,
	COALESCE(financial_reports, '[]'::jsonb) as financial_reports,
	competitive_advantages,
	risk_factors,
	recent_developments,
	COALESCE(social_media_links, '{}'::jsonb) as social_media_links,
	enrichment_status,
	enrichment_date,
	enrichment_error,
	COALESCE(financial_statements, '{}'::jsonb) as financial_statements,
	COALESCE(key_metrics, '{}'::jsonb) as key_metrics
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
	); err != nil {
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

	if info.MarketCap != nil {
		fsInfo.MarketCap = *info.MarketCap
		hasValue = true
	}
	if info.CurrentPrice != nil {
		fsInfo.CurrentPrice = *info.CurrentPrice
		hasValue = true
	}
	if info.PeRatio != nil {
		fsInfo.PeRatio = *info.PeRatio
		hasValue = true
	}
	if info.Eps != nil {
		fsInfo.Eps = *info.Eps
		hasValue = true
	}
	if info.DividendYield != nil {
		fsInfo.DividendYield = *info.DividendYield
		hasValue = true
	}
	if info.Beta != nil {
		fsInfo.Beta = *info.Beta
		hasValue = true
	}
	if info.Week52High != nil {
		fsInfo.Week_52High = *info.Week52High
		hasValue = true
	}
	if info.Week52Low != nil {
		fsInfo.Week_52Low = *info.Week52Low
		hasValue = true
	}
	if info.Volume != nil {
		fsInfo.Volume = *info.Volume
		hasValue = true
	}
	if info.EmployeeCount != nil {
		fsInfo.EmployeeCount = int64(*info.EmployeeCount)
		hasValue = true
	}
	if info.Sector != nil {
		fsInfo.Sector = *info.Sector
		hasValue = true
	}
	if info.Industry != nil {
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

	// Helper to safely convert interface{} to float64
	toFloat64 := func(v interface{}) float64 {
		switch val := v.(type) {
		case float64:
			return val
		case float32:
			return float64(val)
		case int:
			return float64(val)
		case int64:
			return float64(val)
		default:
			return 0
		}
	}

	// Helper to safely convert interface{} to int64
	toInt64 := func(v interface{}) int64 {
		switch val := v.(type) {
		case int:
			return int64(val)
		case int64:
			return val
		case float64:
			return int64(val)
		case float32:
			return int64(val)
		default:
			return 0
		}
	}

	// Helper to safely convert interface{} to string
	toString := func(v interface{}) string {
		if str, ok := v.(string); ok {
			return str
		}
		return ""
	}

	// Merge each field, preferring existing values over key_metrics
	if existing.MarketCap == 0 {
		if v, ok := keyMetrics["market_cap"]; ok && v != nil {
			existing.MarketCap = toFloat64(v)
		}
	}
	if existing.CurrentPrice == 0 {
		if v, ok := keyMetrics["current_price"]; ok && v != nil {
			existing.CurrentPrice = toFloat64(v)
		}
	}
	if existing.PeRatio == 0 {
		if v, ok := keyMetrics["pe_ratio"]; ok && v != nil {
			existing.PeRatio = toFloat64(v)
		}
	}
	if existing.Eps == 0 {
		if v, ok := keyMetrics["eps"]; ok && v != nil {
			existing.Eps = toFloat64(v)
		}
	}
	if existing.DividendYield == 0 {
		if v, ok := keyMetrics["dividend_yield"]; ok && v != nil {
			existing.DividendYield = toFloat64(v)
		}
	}
	if existing.Beta == 0 {
		if v, ok := keyMetrics["beta"]; ok && v != nil {
			existing.Beta = toFloat64(v)
		}
	}
	if existing.Week_52High == 0 {
		if v, ok := keyMetrics["fifty_two_week_high"]; ok && v != nil {
			existing.Week_52High = toFloat64(v)
		}
	}
	if existing.Week_52Low == 0 {
		if v, ok := keyMetrics["fifty_two_week_low"]; ok && v != nil {
			existing.Week_52Low = toFloat64(v)
		}
	}
	if existing.Volume == 0 {
		if v, ok := keyMetrics["avg_volume"]; ok && v != nil {
			existing.Volume = toFloat64(v)
		}
	}
	if existing.EmployeeCount == 0 {
		if v, ok := keyMetrics["employee_count"]; ok && v != nil {
			existing.EmployeeCount = toInt64(v)
		}
	}
	if existing.Sector == "" {
		if v, ok := keyMetrics["sector"]; ok && v != nil {
			existing.Sector = toString(v)
		}
	}
	if existing.Industry == "" {
		if v, ok := keyMetrics["industry"]; ok && v != nil {
			existing.Industry = toString(v)
		}
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
			hostname
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

		if err := rows.Scan(
			&runID, &startedAt, &completedAt, &status, &errMsg,
			&shortsUpdated, &pricesUpdated, &metricsUpdated, &algoliaSynced,
			&duration, &env, &hostname,
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

		runs = append(runs, run)
	}

	return runs, nil
}

