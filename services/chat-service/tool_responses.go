package main

import (
	"bytes"
	"encoding/json"
	"fmt"

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
