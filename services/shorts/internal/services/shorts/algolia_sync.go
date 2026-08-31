package shorts

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

var algoliaTracer = otel.Tracer("shorted.algolia-sync")

// algoliaStockRecord matches the StockRecord struct in market-data-sync/algolia/algolia.go.
// Keeping a local copy avoids importing the market-data-sync module.
type algoliaStockRecord struct {
	ObjectID              string   `json:"objectID"`
	StockCode             string   `json:"stock_code"`
	CompanyName           string   `json:"company_name"`
	Industry              string   `json:"industry,omitempty"`
	Tags                  []string `json:"tags,omitempty"`
	Summary               string   `json:"summary,omitempty"`
	EnhancedSummary       string   `json:"enhanced_summary,omitempty"`
	CompanyHistory        string   `json:"company_history,omitempty"`
	CompetitiveAdvantages string   `json:"competitive_advantages,omitempty"`
	RiskFactors           string   `json:"risk_factors,omitempty"`
	RecentDevelopments    string   `json:"recent_developments,omitempty"`
	Details               string   `json:"details,omitempty"`
	KeyPeopleNames        string   `json:"key_people_names,omitempty"`
	KeyPeopleRoles        []string `json:"key_people_roles,omitempty"`
	LogoGCSURL            string   `json:"logo_gcs_url,omitempty"`
	PercentageShorted     float64  `json:"percentage_shorted"`
	Website               string   `json:"website,omitempty"`
	Address               string   `json:"address,omitempty"`
	MarketCap             string   `json:"market_cap,omitempty"`
	MarketCapNumeric      *float64 `json:"market_cap_numeric,omitempty"`
	PERatio               *float64 `json:"pe_ratio,omitempty"`
	EPS                   *float64 `json:"eps,omitempty"`
	DividendYield         *float64 `json:"dividend_yield,omitempty"`
}

// syncStockToAlgolia queries enriched metadata for a single stock from the DB
// and writes it to Algolia using the admin key via the saveObject REST API.
func (s *ShortsServer) syncStockToAlgolia(ctx context.Context, stockCode string) error {
	ctx, span := algoliaTracer.Start(ctx, "algolia.sync_stock",
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("stock_code", stockCode),
		),
	)
	defer span.End()

	if s.config.AlgoliaAppID == "" || s.config.AlgoliaAdminKey == "" {
		span.SetStatus(codes.Error, "algolia admin key not configured")
		return fmt.Errorf("algolia admin key not configured")
	}

	indexName := s.config.AlgoliaIndex
	if indexName == "" {
		indexName = "stocks"
	}
	span.SetAttributes(attribute.String("algolia.index", indexName))

	// Build the enriched record from DB (same query as market-data-sync buildEnrichedAlgoliaRecords)
	record, err := s.buildAlgoliaRecordFromDB(ctx, stockCode)
	if err != nil {
		span.SetStatus(codes.Error, err.Error())
		return fmt.Errorf("failed to build Algolia record for %s: %w", stockCode, err)
	}

	span.SetAttributes(
		attribute.String("algolia.company_name", record.CompanyName),
		attribute.String("algolia.industry", record.Industry),
		attribute.Float64("algolia.percentage_shorted", record.PercentageShorted),
		attribute.Bool("algolia.has_enhanced_summary", record.EnhancedSummary != ""),
		attribute.Bool("algolia.has_key_people", record.KeyPeopleNames != ""),
	)

	// PUT to Algolia saveObject endpoint
	bodyBytes, err := json.Marshal(record)
	if err != nil {
		span.SetStatus(codes.Error, err.Error())
		return fmt.Errorf("failed to marshal Algolia record: %w", err)
	}
	span.SetAttributes(attribute.Int("algolia.record_size_bytes", len(bodyBytes)))

	url := fmt.Sprintf("https://%s.algolia.net/1/indexes/%s/%s",
		s.config.AlgoliaAppID, indexName, stockCode)

	req, err := http.NewRequestWithContext(ctx, "PUT", url, bytes.NewReader(bodyBytes))
	if err != nil {
		span.SetStatus(codes.Error, err.Error())
		return fmt.Errorf("failed to create Algolia request: %w", err)
	}

	req.Header.Set("X-Algolia-API-Key", s.config.AlgoliaAdminKey)
	req.Header.Set("X-Algolia-Application-Id", s.config.AlgoliaAppID)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		span.SetStatus(codes.Error, err.Error())
		return fmt.Errorf("algolia request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	span.SetAttributes(attribute.Int("algolia.response_status", resp.StatusCode))

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		respBody, _ := io.ReadAll(resp.Body)
		errMsg := fmt.Sprintf("algolia returned status %d: %s", resp.StatusCode, string(respBody))
		span.SetStatus(codes.Error, errMsg)
		return fmt.Errorf("%s", errMsg)
	}

	span.SetStatus(codes.Ok, "synced")
	return nil
}

// buildAlgoliaRecordFromDB queries company-metadata + latest shorts percentage for a single stock.
// This mirrors the SQL in market-data-sync/sync/sync.go buildEnrichedAlgoliaRecords but for one stock.
func (s *ShortsServer) buildAlgoliaRecordFromDB(ctx context.Context, stockCode string) (*algoliaStockRecord, error) {
	_, span := algoliaTracer.Start(ctx, "algolia.build_record_from_db",
		trace.WithSpanKind(trace.SpanKindInternal),
		trace.WithAttributes(attribute.String("stock_code", stockCode)),
	)
	defer span.End()

	query := `
		WITH latest_shorts AS (
			SELECT DISTINCT ON ("PRODUCT_CODE")
				"PRODUCT_CODE" as product_code,
				"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" as percentage_shorted
			FROM shorts
			WHERE "PRODUCT_CODE" = $1
			ORDER BY "PRODUCT_CODE", "DATE" DESC
		)
		SELECT
			m.stock_code,
			COALESCE(m.company_name, '') as company_name,
			COALESCE(m.industry, '') as industry,
			COALESCE(m.summary, '') as summary,
			COALESCE(m.details, '') as details,
			COALESCE(m.enhanced_summary, '') as enhanced_summary,
			COALESCE(m.company_history, '') as company_history,
			COALESCE(m.competitive_advantages, '') as competitive_advantages,
			COALESCE(m.risk_factors, '') as risk_factors,
			COALESCE(m.recent_developments, '') as recent_developments,
			COALESCE(m.tags, ARRAY[]::text[]) as tags,
			COALESCE(m.logo_gcs_url, '') as logo_gcs_url,
			COALESCE(m.website, '') as website,
			COALESCE(m.address, '') as address,
			COALESCE(m.market_cap, '') as market_cap,
			COALESCE(s.percentage_shorted, 0) as percentage_shorted,
			COALESCE(m.key_people, '[]'::jsonb) as key_people,
			COALESCE(m.key_metrics, '{}'::jsonb) as key_metrics
		FROM "company-metadata" m
		LEFT JOIN latest_shorts s ON m.stock_code = s.product_code
		WHERE m.stock_code = $1
	`

	row := s.store.QueryRowContext(ctx, query, stockCode)

	var (
		sc, companyName, industry, summary, details     string
		enhancedSummary, companyHistory, competitiveAdv string
		riskFactors, recentDev                          string
		logoGCSURL, website, address, marketCap         string
		percentageShorted                               float64
		tags                                            []string
		keyPeopleJSON, keyMetricsJSON                   []byte
	)

	if err := row.Scan(
		&sc, &companyName, &industry, &summary, &details,
		&enhancedSummary, &companyHistory, &competitiveAdv,
		&riskFactors, &recentDev, &tags, &logoGCSURL,
		&website, &address, &marketCap, &percentageShorted,
		&keyPeopleJSON, &keyMetricsJSON,
	); err != nil {
		span.SetStatus(codes.Error, err.Error())
		return nil, fmt.Errorf("failed to scan enriched record for %s: %w", stockCode, err)
	}

	// Parse key_people
	var keyPeople []struct {
		Name string `json:"name"`
		Role string `json:"role"`
	}
	_ = json.Unmarshal(keyPeopleJSON, &keyPeople)

	names := make([]string, 0, len(keyPeople))
	roles := make([]string, 0, len(keyPeople))
	for _, p := range keyPeople {
		if p.Name != "" {
			names = append(names, p.Name)
			role := strings.TrimSpace(p.Name + " " + p.Role)
			if role != "" {
				roles = append(roles, role)
			}
		}
	}

	// Parse key_metrics
	var keyMetrics map[string]json.RawMessage
	_ = json.Unmarshal(keyMetricsJSON, &keyMetrics)

	parseMetric := func(raw json.RawMessage) *float64 {
		if raw == nil {
			return nil
		}
		var f float64
		if err := json.Unmarshal(raw, &f); err == nil {
			return &f
		}
		var str string
		if err := json.Unmarshal(raw, &str); err == nil {
			var val float64
			if _, err := fmt.Sscanf(str, "%f", &val); err == nil {
				return &val
			}
		}
		return nil
	}

	span.SetStatus(codes.Ok, "record built")
	return &algoliaStockRecord{
		ObjectID:              sc,
		StockCode:             sc,
		CompanyName:           companyName,
		Industry:              industry,
		Tags:                  tags,
		Summary:               summary,
		EnhancedSummary:       enhancedSummary,
		CompanyHistory:        companyHistory,
		CompetitiveAdvantages: competitiveAdv,
		RiskFactors:           riskFactors,
		RecentDevelopments:    recentDev,
		Details:               details,
		KeyPeopleNames:        strings.Join(names, ", "),
		KeyPeopleRoles:        roles,
		LogoGCSURL:            logoGCSURL,
		PercentageShorted:     percentageShorted,
		Website:               website,
		Address:               address,
		MarketCap:             marketCap,
		PERatio:               parseMetric(keyMetrics["pe_ratio"]),
		EPS:                   parseMetric(keyMetrics["eps"]),
		DividendYield:         parseMetric(keyMetrics["dividend_yield"]),
	}, nil
}

// notifyAlgoliaStockUpdated syncs a single stock to Algolia in a goroutine with a timeout.
// Fire-and-forget: logs errors but doesn't block the caller.
func (s *ShortsServer) notifyAlgoliaStockUpdated(stockCode string) {
	if s.config.AlgoliaAppID == "" || s.config.AlgoliaAdminKey == "" {
		s.logger.Debugf("Algolia admin key not configured, skipping sync for %s", stockCode)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := s.syncStockToAlgolia(ctx, stockCode); err != nil {
		s.logger.Warnf("Failed to sync %s to Algolia after enrichment: %v", stockCode, err)
	} else {
		s.logger.Infof("Synced %s to Algolia after enrichment", stockCode)
	}
}
