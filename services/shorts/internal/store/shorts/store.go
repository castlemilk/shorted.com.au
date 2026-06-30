package shorts

import (
	"context"
	"fmt"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stockv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
)

// Row is a minimal interface for scanning a single database row.
type Row interface {
	Scan(dest ...interface{}) error
}

// SyncStatusFilter defines filtering options for sync status queries
type SyncStatusFilter struct {
	Limit        int
	Environment  string // "production", "development", or empty for all
	ExcludeLocal bool   // if true, exclude runs from local hostnames
}

// JobHealth is one row of the v_job_health view (migration 000046): a job's
// definition joined to its latest run, with precomputed alert flags. It powers
// the admin Jobs overview and is the same shape the email watchdog reads.
// JSON tags are camelCase to match the admin REST conventions.
type JobHealth struct {
	JobName                 string  `json:"jobName"`
	DisplayName             string  `json:"displayName"`
	Description             string  `json:"description"`
	Category                string  `json:"category"`
	ScheduleCron            string  `json:"scheduleCron"`
	ScheduleHuman           string  `json:"scheduleHuman"`
	Critical                bool    `json:"critical"`
	ExpectedIntervalSeconds int64   `json:"expectedIntervalSeconds"`
	LastStatus              string  `json:"lastStatus"`
	LastRunId               string  `json:"lastRunId"`
	LastStartedAt           string  `json:"lastStartedAt"`
	LastCompletedAt         string  `json:"lastCompletedAt"`
	LastDurationSeconds     float64 `json:"lastDurationSeconds"`
	LastRecordsProcessed    int64   `json:"lastRecordsProcessed"`
	LastRecordsFailed       int64   `json:"lastRecordsFailed"`
	LastError               string  `json:"lastError"`
	LastEnvironment         string  `json:"lastEnvironment"`
	LastHostname            string  `json:"lastHostname"`
	LastSuccessAt           string  `json:"lastSuccessAt"`
	RecentAvgRecords        float64 `json:"recentAvgRecords"`
	SecondsSinceSuccess     float64 `json:"secondsSinceSuccess"`
	HasEverRun              bool    `json:"hasEverRun"`
	IsFailed                bool    `json:"isFailed"`
	IsStuck                 bool    `json:"isStuck"`
	IsStale                 bool    `json:"isStale"`
	IsZeroRecord            bool    `json:"isZeroRecord"`
	AlertLevel              string  `json:"alertLevel"` // critical | warning | no_data | ok
}

type Store interface {
	GetStock(string) (*stockv1alpha1.Stock, error)
	GetTopShorts(period string, limit, offset int32, summaryOnly bool) ([]*stockv1alpha1.TimeSeriesData, int, error)
	GetStockDetails(string) (*stockv1alpha1.StockDetails, error)
	GetStockData(string, string) (*stockv1alpha1.TimeSeriesData, error)
	GetIndustryTreeMap(int32, string, string) (*stockv1alpha1.IndustryTreeMap, error)
	RegisterEmail(string) error
	// Newsletter / broadcasts
	UnsubscribeByID(id string) error
	GetSubscriberByID(id string) (email string, unsubscribedAt *time.Time, err error)
	CreateBroadcastDraft(b Broadcast) (id string, err error)
	ListBroadcasts(limit int) ([]Broadcast, error)
	GetBroadcast(id string) (*Broadcast, error)
	SetBroadcastStatus(id, status, errMsg string, recipientCount int) error
	ListActiveSubscribers() ([]Subscriber, error)
	SearchStocks(string, int32) ([]*stockv1alpha1.Stock, error)
	GetMarketByDate(date string, limit, offset int32) ([]*stockv1alpha1.Stock, int, error)
	GetAvailableDates(limit int, before string) ([]string, string, string, int, error)
	GetSyncStatus(filter SyncStatusFilter) ([]*shortsv1alpha1.SyncRun, error)
	CleanupStuckSyncRuns() (int, error)
	GetJobsOverview() ([]*JobHealth, error)

	// Key metrics sync methods
	GetAllStockCodes() ([]string, error)
	StockExists(stockCode string) (bool, error)
	UpdateKeyMetrics(stockCode string, metrics map[string]interface{}) error

	// Enrichment (v2) review workflow methods
	GetTopStocksForEnrichment(limit int32, priority shortsv1alpha1.EnrichmentPriority) ([]*shortsv1alpha1.StockEnrichmentCandidate, error)
	SavePendingEnrichment(enrichmentID, stockCode string, status shortsv1alpha1.EnrichmentStatus, data *shortsv1alpha1.EnrichmentData, quality *shortsv1alpha1.QualityScore) (string, error)
	ListPendingEnrichments(limit int32, offset int32) ([]*shortsv1alpha1.PendingEnrichmentSummary, error)
	GetPendingEnrichment(enrichmentID string) (*shortsv1alpha1.PendingEnrichment, error)
	GetPendingEnrichmentByStockCode(stockCode string) (*shortsv1alpha1.PendingEnrichmentSummary, error)
	ReviewEnrichment(enrichmentID string, approve bool, reviewedBy, reviewNotes string) error
	ApplyEnrichment(stockCode string, data *shortsv1alpha1.EnrichmentData) error

	// Enrichment job methods (async processing)
	CreateEnrichmentJob(stockCode string, force bool) (string, error)
	GetEnrichmentJob(jobID string) (*shortsv1alpha1.EnrichmentJob, error)
	GetActiveEnrichmentJobByStockCode(stockCode string) (*shortsv1alpha1.EnrichmentJob, error)
	UpdateEnrichmentJobStatus(jobID string, status shortsv1alpha1.EnrichmentJobStatus, enrichmentID *string, errorMsg *string) error
	ListEnrichmentJobs(limit, offset int32, status *shortsv1alpha1.EnrichmentJobStatus) ([]*shortsv1alpha1.EnrichmentJob, int32, error)
	ResetStuckJobs(stuckThresholdMinutes int) (int, error) // Reset jobs stuck in processing for > threshold minutes
	CleanupOldCompletedJobs(keepPerStock int) (int, error) // Clean up old completed jobs, keeping only keepPerStock most recent per stock
	UpdateLogoURLs(stockCode, logoGCSURL, logoIconGCSURL string) error
	UpdateLogoURLsWithSVG(stockCode, logoGCSURL, logoIconGCSURL, logoSVGGCSURL, logoSourceURL, logoFormat string) error

	// Enrichment statistics
	GetEnrichmentStats() (*EnrichmentStats, error)

	// API Subscription methods
	GetAPISubscription(userID string) (*APISubscription, error)
	GetAPISubscriptionByCustomer(stripeCustomerID string) (*APISubscription, error)
	UpsertAPISubscription(sub *APISubscription) error
	UpdateAPISubscriptionByCustomer(stripeCustomerID string, update *APISubscriptionUpdate) error

	// Weekly report methods
	GetWeeklyReport(weekSlug string) (*WeeklyReport, error)

	// Financial highlights from extracted reports
	GetStockFinancialHighlights(stockCodes []string, maxPerStock int) (map[string][]FinancialReportHighlight, error)

	// Person enrichment backfill
	GetStocksForPeopleEnrichment(limit int) ([]StockPeopleBackfillRow, error)
	GetStocksForPeopleReenrichment(limit int, afterStockCode string) ([]StockPeopleBackfillRow, error)
	GetStocksForImageBackfill(limit int, afterStockCode string) ([]StockPeopleBackfillRow, error)
	UpdateKeyPeopleEnriched(stockCode string, keyPeopleJSON []byte) error
	// UpdateKeyPeopleIfEmpty writes key_people only when the served row currently has
	// none (§6.5 additive below-gate people write). Returns true when a row was written.
	UpdateKeyPeopleIfEmpty(stockCode string, keyPeopleJSON []byte) (bool, error)

	// News methods
	GetStockNews(stockCode string, limit int32, source, sentiment string) ([]*NewsArticle, int, error)
	GetMarketNews(limit int32, source string, priceSensitiveOnly bool) ([]*NewsArticle, int, error)
	GetRelatedNews(stockCode, articleID string, limit int32) ([]*NewsArticle, error)

	// Editorial Take methods
	GetEditorialTake(slug string) (*EditorialTake, error)
	ListEditorialTakes(limit, offset int32, stockCode string) ([]*EditorialTake, int, error)
	ListEditorialTakesAdmin(limit, offset int32, statusFilter string) ([]*EditorialTake, int, error)
	PublishEditorialTake(slug string) (*EditorialTake, error)
	UpdateEditorialTake(slug string, fields EditorialTakeUpdate) (*EditorialTake, error)
	DeleteEditorialTake(slug string) (bool, error)
	MarkTakeTweetPublished(slug string) (*EditorialTake, error)
	ListTweetPublishQueue(limit int32) ([]*EditorialTake, error)

	// Director trade methods
	GetDirectorTrades(stockCode string, limit int32) ([]*DirectorTrade, int, error)

	// Dividend methods
	GetDividendHistory(stockCode string, years int32) ([]*DividendRecord, int, error)

	// Peer comparison methods
	GetPeerComparison(stockCode string, limit int32) (*PeerComparisonResult, error)

	// Screener methods
	ScreenStocks(filters *shortsv1alpha1.ScreenerFilters, sortField shortsv1alpha1.ScreenerSortField, sortDir shortsv1alpha1.SortDirection, limit, offset int32) ([]*ScreenerStock, int, error)

	// Stock graph methods
	GetStockGraph(stockCode string, limit int32) (*StockGraphResult, error)
	GetStockSignals(stockCode string, limit int32) (*StockSignalsResult, error)

	// House-price tracker methods
	GetHousingOverview(regionType string) ([]*HousingMetricRow, error)
	GetHousePriceSeries(regionCode, measure, dwellingType string) (*HousePriceSeriesResult, error)
	ListStateSuburbs(stateCode, query string, limit int32) ([]*SuburbSummaryRow, error)
	GetSuburbProfile(salCode string) (*SuburbProfileRow, error)
	GetHousingRegions(regionType, stateCode, query string, limit int32) ([]*HousingRegionRow, error)

	// Event timeline methods
	GetEventTimeline(stockCode string, daysBack, limit int32) ([]*TimelineEventRow, error)

	// Raw query access (used for Algolia sync)
	QueryRowContext(ctx context.Context, query string, args ...interface{}) Row
}

// Broadcast represents a mailing-list broadcast stored in the database.
// JSON tags are camelCase to match the admin REST conventions expected by the web TS client.
type Broadcast struct {
	ID             string     `json:"id"`
	Type           string     `json:"type"`
	Subject        string     `json:"subject"`
	HTMLBody       string     `json:"htmlBody"`
	TextBody       string     `json:"textBody"`
	SourceRef      string     `json:"sourceRef"`
	Status         string     `json:"status"`
	RecipientCount int        `json:"recipientCount"`
	Error          string     `json:"error"`
	CreatedAt      time.Time  `json:"createdAt"`
	SentAt         *time.Time `json:"sentAt"`
}

// Subscriber represents an active newsletter subscriber.
type Subscriber struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

// StockPeopleBackfillRow represents a stock needing key_people enrichment
type StockPeopleBackfillRow struct {
	StockCode   string
	CompanyName string
	KeyPeople   []byte // Raw JSONB
}

// EnrichmentStats holds enrichment coverage statistics
type EnrichmentStats struct {
	TotalStocks     int     `json:"total_stocks"`
	Enriched        int     `json:"enriched"`
	PendingReview   int     `json:"pending_review"`
	Failed          int     `json:"failed"`
	Unenriched      int     `json:"unenriched"`
	CoveragePercent float64 `json:"coverage_percent"`
}

// FinancialReportHighlight holds extracted metrics from a single financial report
type FinancialReportHighlight struct {
	ReportTitle string
	ReportType  string
	ReportDate  string
	Metrics     []FinancialMetricEntry
	Digest      string
	Confidence  float64
}

// FinancialMetricEntry represents a single extracted metric
type FinancialMetricEntry struct {
	MetricType string
	SourceText string
	Attributes map[string]string
}

// APISubscription represents a user's API subscription status
type APISubscription struct {
	UserID               string
	UserEmail            string
	StripeCustomerID     string
	StripeSubscriptionID string
	Status               string // active, canceled, past_due, inactive, trialing
	Tier                 string // free, pro, enterprise
	CurrentPeriodStart   *string
	CurrentPeriodEnd     *string
	CancelAtPeriodEnd    bool
}

// APISubscriptionUpdate represents fields to update on a subscription
type APISubscriptionUpdate struct {
	Status             *string
	Tier               *string
	CurrentPeriodStart *string
	CurrentPeriodEnd   *string
	CancelAtPeriodEnd  *bool
}

// WeeklyReport represents a weekly short selling report stored in the database
type WeeklyReport struct {
	ID                string
	WeekSlug          string
	ReportDate        string
	PreviousDate      string
	Headline          string
	Summary           string
	Narrative         []byte // JSON
	TopShorted        []byte // JSON
	Risers            []byte // JSON
	Fallers           []byte // JSON
	IndustryBreakdown []byte // JSON (nullable)
	MarketStats       []byte // JSON (nullable)
	FAQs              []byte // JSON (nullable)
	Citations         []byte // JSON (nullable)
	TrendInsights     []byte // JSON (nullable)
	QualityScore      *float64
	LLMModel          *string
	RetryCount        int
	CreatedAt         string
	PublishedAt       *string
}

// NewsArticle represents a news article from the database
type NewsArticle struct {
	ID                string
	StockCode         string
	Source            string
	Headline          string
	URL               string
	PublishedAt       string
	Sentiment         *string
	RelevanceScore    float64
	IsPriceSensitive  bool
	Summary           *string
	Tags              []byte // JSON
	ImageURL          *string
	SyndicationCount  int32
	SyndicatedSources []string
}

// EditorialTake is a Shorted Take editorial article.
type EditorialTake struct {
	ID               string
	Slug             string
	Headline         string
	StockCode        *string
	BodyMD           string
	Sentiment        *string
	SourceArticleID  *string
	SourceURL        *string
	SourceName       *string
	OGImageURL       *string
	WordCount        *int32
	Model            *string
	PublishedAt      *string
	CreatedAt        string
	HeroImageURL     *string
	InlineImages     []byte // JSONB raw — service layer decodes to []InlineImage
	TweetPublishedAt *string
	Citations        []byte // JSONB raw — service layer decodes to []TakeCitation
	LayoutImages     []byte // JSONB raw — service layer decodes to []LayoutImage
	BodyFormat       string // 'markdown' | 'mdx' — NOT NULL DEFAULT 'markdown'
	Standfirst       *string
	Byline           *string
	HeroCaption      *string
	HeroCredit       *string
}

// TakeCitation matches the proto shape for editorial_takes.citations.
type TakeCitation struct {
	RefID    string `json:"refId"`
	URL      string `json:"url"`
	Source   string `json:"source"`
	Headline string `json:"headline"`
	Date     string `json:"date"`
	Type     string `json:"type"`
}

// EditorialTakeUpdate is the partial-update payload for UpdateEditorialTake.
// Pointer fields = "update if set"; nil = "leave as-is".
type EditorialTakeUpdate struct {
	BodyMD       *string
	Headline     *string
	HeroImageURL *string
	Sentiment    *string
}

// InlineImage matches the proto shape for editorial_takes.inline_images.
type InlineImage struct {
	URL   string `json:"url"`
	Topic string `json:"topic"`
	Alt   string `json:"alt"`
}

// LayoutImage matches the proto shape for editorial_takes.layout_images.
type LayoutImage struct {
	URL              string `json:"url"`
	Style            string `json:"style"`
	Ratio            string `json:"ratio"`
	Brief            string `json:"brief"`
	Caption          string `json:"caption"`
	Placement        string `json:"placement"`
	AnchorAfterBlock int    `json:"anchorAfterBlock"`
}

// DirectorTrade represents a director trade from the database
type DirectorTrade struct {
	ID              string
	StockCode       string
	DirectorName    string
	TradeType       string
	SharesTraded    int64
	PricePerShare   *float64
	TotalValue      *float64
	TradeDate       string
	AnnouncementURL *string
}

// DividendRecord represents a dividend payment from the database
type DividendRecord struct {
	ID                 string
	StockCode          string
	ExDate             string
	PaymentDate        *string
	AmountPerShare     float64
	FrankingPercentage float64
	DividendType       string
}

// PeerStock represents a peer stock for comparison
type PeerStock struct {
	StockCode            string
	CompanyName          string
	Industry             string
	ShortPositionPercent float64
	MarketCap            float64
	PERatio              float64
	DividendYield        float64
	PriceChange1M        float64
}

// PeerComparisonResult holds the subject stock and its peers
type PeerComparisonResult struct {
	Subject  *PeerStock
	Peers    []*PeerStock
	Industry string
}

// GraphPersonRow represents a person connected to a stock, with their other company roles
type GraphPersonRow struct {
	Name        string
	Role        string
	ImageURL    string
	LinkedInURL string
	AlsoAt      []string // OTHER stock codes this person is connected to
}

// GraphPeerRow represents a semantically similar company
type GraphPeerRow struct {
	StockCode   string
	CompanyName string
	Industry    string
	Similarity  float64
}

// StockGraphResult holds the full graph result for a stock
type StockGraphResult struct {
	People           []*GraphPersonRow
	SimilarCompanies []*GraphPeerRow
}

// StockSignalRow represents a single reputation/risk signal for a stock.
type StockSignalRow struct {
	Polarity   string // 'adverse' | 'positive'
	Kind       string
	Headline   string
	Detail     string
	EventDate  string
	Severity   string
	Confidence float64
	Citations  []string
}

// StockSignalsResult holds adverse + positive signals for a stock.
type StockSignalsResult struct {
	Adverse  []*StockSignalRow
	Positive []*StockSignalRow
}

// TimelineEventRow holds a single event from any source for the event timeline
type TimelineEventRow struct {
	Date             string // YYYY-MM-DD
	Type             string // 'announcement' | 'director_trade' | 'news' | 'short_spike'
	Title            string
	Detail           string
	URL              string
	Sentiment        string
	IsPriceSensitive bool
}

func NewStore(config Config) (Store, error) {
	switch config.StorageBackend {
	case PostgresStore:
		return newPostgresStore(config)
	default:
		return nil, fmt.Errorf("unsupported storage backend: %s", config.StorageBackend)
	}
}
