package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
)

const (
	// maxWeeklyReportBytes is the budget for get_weekly_report. The analysis narrative
	// alone is about 4 KB and the movers and sector breakdown come after it, so the
	// report gets more room than the default budget. The trimmed report is about 9 KB.
	maxWeeklyReportBytes = 12000

	// weeklyListLimit is how many entries of each weekly list the model sees. The
	// full lists carry history series and logos the model does not use.
	weeklyListLimit = 5

	// keyPeopleLimit is how many key people a stock profile lists.
	keyPeopleLimit = 8

	// maxSignalsPerPolarity is how many adverse and how many positive signals reach the
	// model. The API may return more, and the budget may cut further.
	maxSignalsPerPolarity = 10

	// signalSourceURLBytes is the longest publisher URL a signal keeps. A longer one is
	// dropped and its domain is kept.
	signalSourceURLBytes = 200

	// topShortsSparklinePoints is how many points each stock's sparkline keeps. The chat
	// card draws them as a small line, so eight shows the shape at a fraction of the bytes.
	topShortsSparklinePoints = 8
)

// stockDetailsResult is the profile get_stock_details returns to the model. It takes
// the valuation figures from the financial statements' info block, which is where
// the API keeps market cap. The statements, filings and industry history are left
// out: they are most of the 65 KB response and pushed market cap past the budget.
type stockDetailsResult struct {
	ProductCode           string      `json:"productCode"`
	CompanyName           string      `json:"companyName,omitempty"`
	Industry              string      `json:"industry,omitempty"`
	MarketCap             float64     `json:"marketCap,omitempty"`
	CurrentPrice          float64     `json:"currentPrice,omitempty"`
	PERatio               float64     `json:"peRatio,omitempty"`
	EPS                   float64     `json:"eps,omitempty"`
	DividendYield         float64     `json:"dividendYield,omitempty"`
	Week52High            float64     `json:"week52High,omitempty"`
	Week52Low             float64     `json:"week52Low,omitempty"`
	Website               string      `json:"website,omitempty"`
	Summary               string      `json:"summary,omitempty"`
	EnhancedSummary       string      `json:"enhancedSummary,omitempty"`
	CompanyHistory        string      `json:"companyHistory,omitempty"`
	CompetitiveAdvantages string      `json:"competitiveAdvantages,omitempty"`
	RiskFactors           []string    `json:"riskFactors,omitempty"`
	RecentDevelopments    string      `json:"recentDevelopments,omitempty"`
	KeyPeople             []keyPerson `json:"keyPeople,omitempty"`
}

// keyPerson is a director or executive, without the image and source links.
type keyPerson struct {
	Name string `json:"name"`
	Role string `json:"role,omitempty"`
}

// summarizeStockDetails decodes a GetStockDetails response and returns the profile
// the model needs, with market cap first among the figures.
func summarizeStockDetails(respBody []byte) (string, error) {
	var details stocksv1alpha1.StockDetails
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(respBody, &details); err != nil {
		return "", fmt.Errorf("decode GetStockDetails response: %w", err)
	}

	// Getters on a nil message return zero values, so a stock without statements
	// simply has no valuation figures.
	info := details.GetFinancialStatements().GetInfo()
	result := stockDetailsResult{
		ProductCode:           details.GetProductCode(),
		CompanyName:           details.GetCompanyName(),
		Industry:              details.GetIndustry(),
		MarketCap:             info.GetMarketCap(),
		CurrentPrice:          info.GetCurrentPrice(),
		PERatio:               info.GetPeRatio(),
		EPS:                   info.GetEps(),
		DividendYield:         info.GetDividendYield(),
		Week52High:            info.GetWeek_52High(),
		Week52Low:             info.GetWeek_52Low(),
		Website:               details.GetWebsite(),
		Summary:               details.GetSummary(),
		EnhancedSummary:       details.GetEnhancedSummary(),
		CompanyHistory:        details.GetCompanyHistory(),
		CompetitiveAdvantages: details.GetCompetitiveAdvantages(),
		RiskFactors:           details.GetRiskFactors(),
		RecentDevelopments:    details.GetRecentDevelopments(),
	}
	for _, person := range details.GetKeyPeople() {
		if len(result.KeyPeople) == keyPeopleLimit {
			break
		}
		result.KeyPeople = append(result.KeyPeople, keyPerson{Name: person.GetName(), Role: person.GetRole()})
	}

	resultBytes, err := json.Marshal(result)
	if err != nil {
		return "", fmt.Errorf("marshal GetStockDetails result: %w", err)
	}
	return string(resultBytes), nil
}

// summarizeWeeklyReport decodes a GetWeeklyReport response and keeps the headline,
// summary, narrative, market statistics, the top weekly lists and the sector
// breakdown. The trend insights and FAQs repeat the narrative and are dropped, and
// the list entries drop their history series and logos.
func summarizeWeeklyReport(respBody []byte) (string, error) {
	var report shortsv1alpha1.GetWeeklyReportResponse
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(respBody, &report); err != nil {
		return "", fmt.Errorf("decode GetWeeklyReport response: %w", err)
	}

	trimmed := &shortsv1alpha1.GetWeeklyReportResponse{
		WeekSlug:          report.GetWeekSlug(),
		Headline:          report.GetHeadline(),
		Summary:           report.GetSummary(),
		ReportDate:        report.GetReportDate(),
		PreviousDate:      report.GetPreviousDate(),
		MarketStats:       report.GetMarketStats(),
		TopShorted:        weeklyTopShorted(report.GetTopShorted()),
		Risers:            weeklyMovers(report.GetRisers()),
		Fallers:           weeklyMovers(report.GetFallers()),
		IndustryBreakdown: report.GetIndustryBreakdown(),
		Narrative:         report.GetNarrative(),
		Citations:         weeklyCitations(report.GetCitations()),
	}
	return marshalProtoJSON(trimmed)
}

func weeklyTopShorted(stocks []*shortsv1alpha1.WeeklyReportStock) []*shortsv1alpha1.WeeklyReportStock {
	out := make([]*shortsv1alpha1.WeeklyReportStock, 0, min(len(stocks), weeklyListLimit))
	for _, stock := range stocks[:min(len(stocks), weeklyListLimit)] {
		out = append(out, &shortsv1alpha1.WeeklyReportStock{
			Rank:         stock.GetRank(),
			Code:         stock.GetCode(),
			Name:         stock.GetName(),
			ShortPct:     stock.GetShortPct(),
			WowChange:    stock.GetWowChange(),
			DaysToCover:  stock.GetDaysToCover(),
			IsNewEntrant: stock.GetIsNewEntrant(),
		})
	}
	return out
}

func weeklyMovers(movers []*shortsv1alpha1.WeeklyReportMover) []*shortsv1alpha1.WeeklyReportMover {
	out := make([]*shortsv1alpha1.WeeklyReportMover, 0, min(len(movers), weeklyListLimit))
	for _, mover := range movers[:min(len(movers), weeklyListLimit)] {
		out = append(out, &shortsv1alpha1.WeeklyReportMover{
			Code:        mover.GetCode(),
			Name:        mover.GetName(),
			CurrentPct:  mover.GetCurrentPct(),
			PreviousPct: mover.GetPreviousPct(),
			Change:      mover.GetChange(),
			ZScore:      mover.GetZScore(),
			StreakWeeks: mover.GetStreakWeeks(),
		})
	}
	return out
}

// weeklyCitations keeps the sources the narrative's [ref-N] markers point to. The URLs
// are left out.
func weeklyCitations(citations []*shortsv1alpha1.WeeklyReportCitation) []*shortsv1alpha1.WeeklyReportCitation {
	out := make([]*shortsv1alpha1.WeeklyReportCitation, 0, len(citations))
	for _, citation := range citations {
		out = append(out, &shortsv1alpha1.WeeklyReportCitation{
			Id:     citation.GetId(),
			Source: citation.GetSource(),
			Date:   citation.GetDate(),
			Type:   citation.GetType(),
		})
	}
	return out
}

// stockSignalsResult is the risk and reputation view get_stock_signals returns. When the
// answer is over budget, summarizeStockSignals drops positive items before adverse ones.
type stockSignalsResult struct {
	Adverse         []stockSignalItem `json:"adverse"`
	Positive        []stockSignalItem `json:"positive"`
	OmittedAdverse  int               `json:"omittedAdverse,omitempty"`
	OmittedPositive int               `json:"omittedPositive,omitempty"`
}

// stockSignalItem is one signal without its citations. The API stores each citation as
// a Gemini grounding redirect, about 300 bytes that name no publisher, so the one
// source kept is the domain of a citation that links to a publisher.
type stockSignalItem struct {
	Polarity  string `json:"polarity"`
	Kind      string `json:"kind,omitempty"`
	Headline  string `json:"headline"`
	Detail    string `json:"detail,omitempty"`
	Date      string `json:"date,omitempty"`
	Severity  string `json:"severity,omitempty"`
	Source    string `json:"source,omitempty"`
	SourceURL string `json:"sourceUrl,omitempty"`
}

// summarizeStockSignals decodes a GetStockSignals response into the items the model
// needs. Each polarity keeps its first maxSignalsPerPolarity items in priority order.
// If the result still exceeds the budget, positive items are dropped first, then
// adverse ones from the end of their list, so the output is always valid JSON within
// maxToolResultBytes. The omitted counts say how many were left out.
func summarizeStockSignals(respBody []byte) (string, error) {
	var response shortsv1alpha1.GetStockSignalsResponse
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(respBody, &response); err != nil {
		return "", fmt.Errorf("decode GetStockSignals response: %w", err)
	}

	// The response is decoded for this call alone, so its lists are sorted in place.
	adverse := response.GetAdverse()
	positive := response.GetPositive()
	sortSignalsInPriorityOrder(adverse)
	sortSignalsInPriorityOrder(positive)
	result := stockSignalsResult{
		Adverse:  stockSignalItems(adverse[:min(len(adverse), maxSignalsPerPolarity)]),
		Positive: stockSignalItems(positive[:min(len(positive), maxSignalsPerPolarity)]),
	}

	for {
		result.OmittedAdverse = len(adverse) - len(result.Adverse)
		result.OmittedPositive = len(positive) - len(result.Positive)
		resultBytes, err := json.Marshal(result)
		if err != nil {
			return "", fmt.Errorf("marshal GetStockSignals result: %w", err)
		}
		if len(resultBytes) <= maxToolResultBytes || len(result.Adverse)+len(result.Positive) == 0 {
			return string(resultBytes), nil
		}
		if len(result.Positive) > 0 {
			result.Positive = result.Positive[:len(result.Positive)-1]
		} else {
			result.Adverse = result.Adverse[:len(result.Adverse)-1]
		}
	}
}

// sortSignalsInPriorityOrder sorts signals in place. Severity ranks first, so a serious
// adverse signal is never cut for a minor one; the API rates positive signals low, so
// those sort by date. Within a severity the newest comes first, an undated signal sorts
// last, and ties keep the API's order.
func sortSignalsInPriorityOrder(signals []*shortsv1alpha1.StockSignal) {
	sort.SliceStable(signals, func(i, j int) bool {
		a, b := signals[i], signals[j]
		if ra, rb := severityRank(a.GetSeverity()), severityRank(b.GetSeverity()); ra != rb {
			return ra < rb
		}
		da, db := signalSortDate(a.GetEventDate()), signalSortDate(b.GetEventDate())
		if da == "" || db == "" {
			return da != "" && db == ""
		}
		return da > db
	})
}

// signalDatePrefix matches the year, year-month or date a signal's event date starts
// with. The API also sends values such as "2019 onwards" and "Unknown".
var signalDatePrefix = regexp.MustCompile(`^\d{4}(?:-\d{2}(?:-\d{2})?)?`)

// signalSortDate returns the leading year, year-month or date of an event date, or ""
// when it has none. Raw strings would sort "Unknown" after every digit, ahead of the
// dated signals. A shorter prefix is the smaller string, so newest first puts a year
// alone after the dates within it.
func signalSortDate(eventDate string) string {
	return signalDatePrefix.FindString(eventDate)
}

// severityRank orders severities from high to low. A severity the API does not name
// sorts last.
func severityRank(severity string) int {
	switch severity {
	case "high":
		return 0
	case "medium":
		return 1
	case "low":
		return 2
	default:
		return 3
	}
}

// stockSignalItems converts signals to the items the model reads, in the order given.
func stockSignalItems(signals []*shortsv1alpha1.StockSignal) []stockSignalItem {
	items := make([]stockSignalItem, 0, len(signals))
	for _, signal := range signals {
		source, sourceURL := signalSource(signal.GetCitations())
		items = append(items, stockSignalItem{
			Polarity:  signal.GetPolarity(),
			Kind:      signal.GetKind(),
			Headline:  signal.GetHeadline(),
			Detail:    signal.GetDetail(),
			Date:      signal.GetEventDate(),
			Severity:  signal.GetSeverity(),
			Source:    source,
			SourceURL: sourceURL,
		})
	}
	return items
}

// signalSource returns the domain of the first citation that links to a publisher, and
// the citation itself when it is short enough to keep. Grounding redirects are skipped,
// because they name Gemini's grounding service rather than the publisher.
func signalSource(citations []string) (domain, sourceURL string) {
	for _, citation := range citations {
		parsed, err := url.Parse(citation)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" {
			continue
		}
		if isGroundingRedirect(parsed) {
			continue
		}
		domain = strings.TrimPrefix(strings.ToLower(parsed.Hostname()), "www.")
		if len(citation) <= signalSourceURLBytes {
			sourceURL = citation
		}
		return domain, sourceURL
	}
	return "", ""
}

// groundingRedirectHost is the host of the Gemini grounding redirects the API stores for
// web-search citations.
const groundingRedirectHost = "vertexaisearch.cloud.google.com"

// isGroundingRedirect reports whether a citation is one of the Gemini grounding
// redirects. url.Parse keeps the host's case as written, so the host is lower-cased
// before it is matched, and the match is exact or on a whole label, never a suffix.
func isGroundingRedirect(u *url.URL) bool {
	host := strings.ToLower(u.Hostname())
	return host == groundingRedirectHost || strings.HasSuffix(host, "."+groundingRedirectHost)
}

// topShortsResult is the top shorts list get_top_shorts returns, in rank order.
type topShortsResult struct {
	TimeSeries    []topShortRow `json:"timeSeries"`
	OmittedStocks int           `json:"omittedStocks,omitempty"`
}

// topShortRow is one stock: its latest short position and its thinned sparkline. Lower
// rows can lose the sparkline when the answer is long. The JSON names match the proto's,
// which the web chat card reads.
type topShortRow struct {
	ProductCode         string          `json:"productCode"`
	Name                string          `json:"name,omitempty"`
	LatestShortPosition float64         `json:"latestShortPosition"`
	Points              []topShortPoint `json:"points"`
}

type topShortPoint struct {
	Timestamp     string  `json:"timestamp"`
	ShortPosition float64 `json:"shortPosition"`
}

// summarizeTopShorts decodes a GetTopShorts response into rows the chat card can draw.
// Each sparkline is thinned to topShortsSparklinePoints. If the rows still exceed the
// budget, sparklines are cleared from the lowest-ranked rows first, and whole rows are
// dropped only once no sparkline is left to clear. omittedStocks counts the dropped rows,
// so the output is always valid JSON within maxToolResultBytes.
func summarizeTopShorts(respBody []byte) (string, error) {
	var response shortsv1alpha1.GetTopShortsResponse
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(respBody, &response); err != nil {
		return "", fmt.Errorf("decode GetTopShorts response: %w", err)
	}

	result := topShortsResult{TimeSeries: make([]topShortRow, 0, len(response.GetTimeSeries()))}
	for _, series := range response.GetTimeSeries() {
		row := topShortRow{
			ProductCode:         series.GetProductCode(),
			Name:                series.GetName(),
			LatestShortPosition: series.GetLatestShortPosition(),
			Points:              make([]topShortPoint, 0, topShortsSparklinePoints),
		}
		for _, point := range thinSparkline(series.GetPoints(), topShortsSparklinePoints) {
			row.Points = append(row.Points, topShortPoint{
				Timestamp:     point.GetTimestamp().AsTime().UTC().Format(time.RFC3339),
				ShortPosition: point.GetShortPosition(),
			})
		}
		result.TimeSeries = append(result.TimeSeries, row)
	}

	for {
		resultBytes, err := json.Marshal(result)
		if err != nil {
			return "", fmt.Errorf("marshal GetTopShorts result: %w", err)
		}
		if len(resultBytes) <= maxToolResultBytes || len(result.TimeSeries) == 0 {
			return string(resultBytes), nil
		}
		// A row without its sparkline is far smaller, so clearing sparklines keeps more
		// stocks than dropping rows would.
		if !clearLowestSparkline(result.TimeSeries) {
			result.TimeSeries = result.TimeSeries[:len(result.TimeSeries)-1]
			result.OmittedStocks++
		}
	}
}

// clearLowestSparkline empties the sparkline of the lowest-ranked row that still has one,
// and reports whether it found one. The first row is never cleared: the chat card draws
// only that row's sparkline, and it needs at least two points to draw it.
func clearLowestSparkline(rows []topShortRow) bool {
	for i := len(rows) - 1; i > 0; i-- {
		if len(rows[i].Points) > 0 {
			rows[i].Points = []topShortPoint{}
			return true
		}
	}
	return false
}

// thinSparkline keeps limit points spaced evenly through a series in time order, and
// always keeps the first and the latest. The first is where the window starts, and the
// latest is the position date the model cites. limit must be at least 2.
func thinSparkline(points []*stocksv1alpha1.TimeSeriesPoint, limit int) []*stocksv1alpha1.TimeSeriesPoint {
	n := len(points)
	if n <= limit {
		return points
	}
	thinned := make([]*stocksv1alpha1.TimeSeriesPoint, 0, limit)
	for k := range limit {
		// k=0 is index 0 and k=limit-1 is index n-1. The step is above one index, so
		// the indices are strictly increasing and never repeat.
		thinned = append(thinned, points[k*(n-1)/(limit-1)])
	}
	return thinned
}

// directorTradesResult is the trade list get_director_trades returns to the model, in
// the API's order, newest first. TotalCount is the number of trades the API returned.
// OmittedTrades counts the trades dropped to keep the answer within the budget, so the
// table can say how many it did not draw.
type directorTradesResult struct {
	Trades        []directorTradeRow `json:"trades,omitempty"`
	TotalCount    int32              `json:"totalCount,omitempty"`
	OmittedTrades int                `json:"omittedTrades,omitempty"`
}

// directorTradeRow is one trade. The stock code and the trade id are left out: every
// row is the stock the caller asked for, and the model does not cite ids.
type directorTradeRow struct {
	DirectorName    string  `json:"directorName,omitempty"`
	TradeType       string  `json:"tradeType,omitempty"`
	TradeDate       string  `json:"tradeDate,omitempty"`
	SharesTraded    int64   `json:"sharesTraded,omitempty"`
	PricePerShare   float64 `json:"pricePerShare,omitempty"`
	TotalValue      float64 `json:"totalValue,omitempty"`
	AnnouncementURL string  `json:"announcementUrl,omitempty"`
}

// summarizeDirectorTrades decodes a GetDirectorTrades response into the trade list the chat
// table draws. Rows are kept in the API's order. When the answer is over the budget, the
// trailing trades are dropped and OmittedTrades counts them, so the output is always valid
// JSON within maxToolResultBytes and the table names the trades it did not draw.
func summarizeDirectorTrades(respBody []byte) (string, error) {
	var response shortsv1alpha1.GetDirectorTradesResponse
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(respBody, &response); err != nil {
		return "", fmt.Errorf("decode GetDirectorTrades response: %w", err)
	}

	result := directorTradesResult{TotalCount: response.GetTotalCount()}
	for _, trade := range response.GetTrades() {
		result.Trades = append(result.Trades, directorTradeRow{
			DirectorName:    trade.GetDirectorName(),
			TradeType:       trade.GetTradeType(),
			TradeDate:       trade.GetTradeDate(),
			SharesTraded:    trade.GetSharesTraded(),
			PricePerShare:   trade.GetPricePerShare(),
			TotalValue:      trade.GetTotalValue(),
			AnnouncementURL: trade.GetAnnouncementUrl(),
		})
	}

	for {
		resultBytes, err := json.Marshal(result)
		if err != nil {
			return "", fmt.Errorf("marshal GetDirectorTrades result: %w", err)
		}
		if len(resultBytes) <= maxToolResultBytes || len(result.Trades) == 0 {
			return string(resultBytes), nil
		}
		result.Trades = result.Trades[:len(result.Trades)-1]
		result.OmittedTrades++
	}
}

// marshalProtoJSON encodes a message in the API's JSON names. protojson adds random
// spacing, so the output is compacted to one stable form.
func marshalProtoJSON(msg proto.Message) (string, error) {
	raw, err := protojson.Marshal(msg)
	if err != nil {
		return "", fmt.Errorf("marshal %s result: %w", msg.ProtoReflect().Descriptor().FullName(), err)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		return "", fmt.Errorf("compact %s result: %w", msg.ProtoReflect().Descriptor().FullName(), err)
	}
	return compact.String(), nil
}
