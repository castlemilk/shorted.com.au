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
	"google.golang.org/protobuf/encoding/protojson"
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

func (s *postgresStore) SavePendingEnrichment(enrichmentID, stockCode string, status shortsv1alpha1.EnrichmentStatus, data *shortsv1alpha1.EnrichmentData, quality *shortsv1alpha1.QualityScore) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if enrichmentID == "" {
		return fmt.Errorf("enrichmentID is required")
	}
	if stockCode == "" {
		return fmt.Errorf("stockCode is required")
	}
	if data == nil {
		return fmt.Errorf("enrichment data is required")
	}
	if quality == nil {
		return fmt.Errorf("quality score is required")
	}

	dataJSON, err := protojson.Marshal(data)
	if err != nil {
		return fmt.Errorf("failed to marshal enrichment data: %w", err)
	}
	qualityJSON, err := protojson.Marshal(quality)
	if err != nil {
		return fmt.Errorf("failed to marshal quality score: %w", err)
	}

	dbStatus := enrichmentStatusToDB(status)

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

	_, err = s.db.Exec(ctx, query, enrichmentID, stockCode, dataJSON, qualityJSON, dbStatus)
	if err != nil {
		return fmt.Errorf("failed to save pending enrichment: %w", err)
	}
	return nil
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

	enhancedSummary := sql.NullString{String: data.EnhancedSummary, Valid: data.EnhancedSummary != ""}
	companyHistory := sql.NullString{String: data.CompanyHistory, Valid: data.CompanyHistory != ""}
	competitiveAdvantages := sql.NullString{String: data.CompetitiveAdvantages, Valid: data.CompetitiveAdvantages != ""}
	recentDevelopments := sql.NullString{String: data.RecentDevelopments, Valid: data.RecentDevelopments != ""}

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
			enrichment_error = NULL
		WHERE stock_code = $1
	`

	result, err := s.db.Exec(
		ctx,
		query,
		stockCode,
		data.Tags,
		enhancedSummary,
		companyHistory,
		keyPeopleJSON,
		reportsJSON,
		competitiveAdvantages,
		data.RiskFactors,
		recentDevelopments,
		socialLinksJSON,
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

