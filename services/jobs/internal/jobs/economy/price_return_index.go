package economy

import (
	"context"
	"fmt"
	"log"
	"math"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	maxStockMonthlyPriceReturn = 2.0
	maxStateMonthlyPriceReturn = 0.25
)

// priceReturnIndexQuery loads the monthly-last raw and adjusted closes plus
// current exposure inputs. Consecutive-month chaining, weighted state
// aggregation, the constituent floor, and cumulative indexing stay in pure Go
// below.
const priceReturnIndexQuery = `
WITH monthly_last AS (
  SELECT DISTINCT ON (p.stock_code, date_trunc('month', p.date))
    p.stock_code,
    date_trunc('month', p.date)::date AS month,
    p.close::double precision                     AS close,
    NULLIF(p.adjusted_close, 0)::double precision AS adjusted_close
  FROM stock_prices p
  WHERE p.close IS NOT NULL
    AND p.close > 0
  ORDER BY p.stock_code, date_trunc('month', p.date), p.date DESC
)
SELECT
  m.stock_code,
  e.region,
  m.month,
  m.close,
  m.adjusted_close,
  e.weight::double precision,
  e.market_cap::double precision
FROM monthly_last m
JOIN mv_company_state_exposure e ON e.stock_code = m.stock_code
WHERE e.region <> 'international'
  AND e.market_cap IS NOT NULL
  AND e.market_cap > 0
  AND e.weight IS NOT NULL
  AND e.weight > 0
ORDER BY m.stock_code, m.month, e.region`

type monthlyPriceExposureRow struct {
	StockCode      string
	Region         string
	Period         time.Time
	Close          float64
	AdjustedClose  *float64
	ExposureWeight float64
	MarketCap      float64
}

type weightedStockReturnRow struct {
	StockCode string
	Region    string
	Period    time.Time
	Return    float64
	Weight    float64
}

type priceReturnRow struct {
	Region       string
	Period       time.Time
	Return       float64
	Constituents int64
}

func priceReturnIndexSeriesDef(region string) (SeriesDef, bool) {
	name, ok := marketStateNames[region]
	if !ok {
		return SeriesDef{}, false
	}
	return SeriesDef{
		Topic:      "markets",
		Metric:     "price_return_index",
		RegionType: "state",
		RegionCode: region,
		RegionName: name,
		Unit:       "index",
		Frequency:  "monthly",
		Adjustment: "original",
		SourceKey:  "derived-shorted-markets",
		Licence:    "derived",
		Dimensions: map[string]string{
			"basis":     "current-constituent",
			"weighting": "weight_x_market_cap",
		},
	}, true
}

type stockMonth struct {
	StockCode        string
	Period           time.Time
	Close            float64
	AdjustedClose    float64
	HasAdjustedClose bool
}

type seriesPeriodKey struct {
	Code   string
	Period time.Time
}

// consecutiveStockPriceReturns breaks a stock's chain when its immediately
// prior observation is not the previous calendar month. If data resumes, the
// resumed month establishes a new base and the following consecutive month
// can produce a return.
func consecutiveStockPriceReturns(rows []monthlyPriceExposureRow) ([]weightedStockReturnRow, error) {
	priceByStockMonth := make(map[seriesPeriodKey]stockMonth, len(rows))
	for _, row := range rows {
		if row.Close <= 0 || math.IsNaN(row.Close) || math.IsInf(row.Close, 0) {
			return nil, fmt.Errorf(
				"stock close drift for %s at %s: %v",
				row.StockCode, row.Period.Format("2006-01-02"), row.Close,
			)
		}
		if row.AdjustedClose != nil &&
			(*row.AdjustedClose <= 0 || math.IsNaN(*row.AdjustedClose) || math.IsInf(*row.AdjustedClose, 0)) {
			return nil, fmt.Errorf(
				"stock adjusted close drift for %s at %s: %v",
				row.StockCode, row.Period.Format("2006-01-02"), *row.AdjustedClose,
			)
		}
		key := seriesPeriodKey{Code: row.StockCode, Period: row.Period}
		adjustedClose := 0.0
		hasAdjustedClose := row.AdjustedClose != nil
		if hasAdjustedClose {
			adjustedClose = *row.AdjustedClose
		}
		if existing, ok := priceByStockMonth[key]; ok {
			if existing.Close != row.Close {
				return nil, fmt.Errorf(
					"inconsistent monthly close for %s at %s: %v and %v",
					row.StockCode, row.Period.Format("2006-01-02"), existing.Close, row.Close,
				)
			}
			if existing.HasAdjustedClose != hasAdjustedClose ||
				(hasAdjustedClose && existing.AdjustedClose != adjustedClose) {
				return nil, fmt.Errorf(
					"inconsistent monthly adjusted close for %s at %s",
					row.StockCode, row.Period.Format("2006-01-02"),
				)
			}
		}
		priceByStockMonth[key] = stockMonth{
			StockCode:        row.StockCode,
			Period:           row.Period,
			Close:            row.Close,
			AdjustedClose:    adjustedClose,
			HasAdjustedClose: hasAdjustedClose,
		}
	}

	prices := make([]stockMonth, 0, len(priceByStockMonth))
	for _, price := range priceByStockMonth {
		prices = append(prices, price)
	}
	sort.Slice(prices, func(i, j int) bool {
		if prices[i].StockCode != prices[j].StockCode {
			return prices[i].StockCode < prices[j].StockCode
		}
		return prices[i].Period.Before(prices[j].Period)
	})

	returnByStockMonth := make(map[seriesPeriodKey]float64, len(prices))
	droppedStockMonthReturns := 0
	var previous stockMonth
	havePrevious := false
	for _, price := range prices {
		if havePrevious && previous.StockCode == price.StockCode &&
			previous.Period.AddDate(0, 1, 0).Equal(price.Period) {
			previousPrice, currentPrice := previous.Close, price.Close
			// Adjusted prices are pair-consistent: use them only when both
			// consecutive months have one. At a missing-data boundary, mixing
			// adjusted and raw columns would itself manufacture a price jump,
			// so the pair deliberately falls back to raw close/raw close.
			if previous.HasAdjustedClose && price.HasAdjustedClose {
				previousPrice = previous.AdjustedClose
				currentPrice = price.AdjustedClose
			}
			monthlyReturn := currentPrice/previousPrice - 1
			if math.IsNaN(monthlyReturn) || math.IsInf(monthlyReturn, 0) {
				return nil, fmt.Errorf(
					"stock return drift for %s at %s: %v",
					price.StockCode, price.Period.Format("2006-01-02"), monthlyReturn,
				)
			}
			if math.Abs(monthlyReturn) > maxStockMonthlyPriceReturn {
				droppedStockMonthReturns++
			} else {
				returnByStockMonth[seriesPeriodKey{Code: price.StockCode, Period: price.Period}] = monthlyReturn
			}
		}
		previous = price
		havePrevious = true
	}

	returns := make([]weightedStockReturnRow, 0, len(rows))
	for _, row := range rows {
		monthlyReturn, ok := returnByStockMonth[seriesPeriodKey{Code: row.StockCode, Period: row.Period}]
		if !ok {
			continue
		}
		weight := row.ExposureWeight * row.MarketCap
		if weight <= 0 || math.IsNaN(weight) || math.IsInf(weight, 0) {
			return nil, fmt.Errorf(
				"price-return weight drift for %s/%s at %s: %v",
				row.StockCode, row.Region, row.Period.Format("2006-01-02"), weight,
			)
		}
		returns = append(returns, weightedStockReturnRow{
			StockCode: row.StockCode,
			Region:    row.Region,
			Period:    row.Period,
			Return:    monthlyReturn,
			Weight:    weight,
		})
	}
	if droppedStockMonthReturns > 0 {
		log.Printf(
			"WARNING: dropped %d stock-month price returns outside ±%.0f%% sanity bound before state aggregation",
			droppedStockMonthReturns, maxStockMonthlyPriceReturn*100,
		)
	}
	return returns, nil
}

type statePriceReturnAccumulator struct {
	numerator   float64
	denominator float64
	stocks      map[string]struct{}
}

func aggregateStatePriceReturns(rows []weightedStockReturnRow) ([]priceReturnRow, error) {
	byRegionMonth := make(map[seriesPeriodKey]*statePriceReturnAccumulator)
	for _, row := range rows {
		if math.IsNaN(row.Return) || math.IsInf(row.Return, 0) ||
			row.Weight <= 0 || math.IsNaN(row.Weight) || math.IsInf(row.Weight, 0) {
			return nil, fmt.Errorf(
				"weighted stock return drift for %s/%s at %s",
				row.StockCode, row.Region, row.Period.Format("2006-01-02"),
			)
		}
		key := seriesPeriodKey{Code: row.Region, Period: row.Period}
		accumulator, ok := byRegionMonth[key]
		if !ok {
			accumulator = &statePriceReturnAccumulator{stocks: make(map[string]struct{})}
			byRegionMonth[key] = accumulator
		}
		if _, duplicate := accumulator.stocks[row.StockCode]; duplicate {
			return nil, fmt.Errorf(
				"duplicate stock exposure for %s/%s at %s",
				row.StockCode, row.Region, row.Period.Format("2006-01-02"),
			)
		}
		accumulator.numerator += row.Weight * row.Return
		accumulator.denominator += row.Weight
		accumulator.stocks[row.StockCode] = struct{}{}
	}

	stateRows := make([]priceReturnRow, 0, len(byRegionMonth))
	for key, accumulator := range byRegionMonth {
		if accumulator.denominator <= 0 {
			return nil, fmt.Errorf(
				"non-positive state price-return denominator for %s at %s",
				key.Code, key.Period.Format("2006-01-02"),
			)
		}
		stateRows = append(stateRows, priceReturnRow{
			Region:       key.Code,
			Period:       key.Period,
			Return:       accumulator.numerator / accumulator.denominator,
			Constituents: int64(len(accumulator.stocks)),
		})
	}
	return stateRows, nil
}

// assemblePriceReturnIndexObs applies the constituent floor, drift guard, and
// base-100 cumulative product without a database dependency. Each state's
// first qualifying return month is the base observation at exactly 100, so
// that discarded base return is not drift-checked. Once based, below-floor
// months remain unpublished but are priced into the running level to preserve
// index continuity. A state that breaches the monthly-return guard is omitted
// in full; the family fails only when no state series survives assembly.
func assembleStatePriceReturnIndexObs(rows []priceReturnRow) ([]Obs, error) {
	sortedRows := append([]priceReturnRow(nil), rows...)
	sort.SliceStable(sortedRows, func(i, j int) bool {
		if sortedRows[i].Region != sortedRows[j].Region {
			return sortedRows[i].Region < sortedRows[j].Region
		}
		return sortedRows[i].Period.Before(sortedRows[j].Period)
	})

	obs := make([]Obs, 0, len(sortedRows))
	for start := 0; start < len(sortedRows); {
		end := start + 1
		for end < len(sortedRows) && sortedRows[end].Region == sortedRows[start].Region {
			end++
		}

		stateObs, breach, err := assembleSingleStatePriceReturnIndexObs(sortedRows[start:end])
		if err != nil {
			return nil, err
		}
		if breach != nil {
			log.Printf(
				"WARNING: excluding entire price-return index series for %s this run: monthly return at %s was %.6f outside ±%.0f%%",
				breach.Region, breach.Period.Format("2006-01-02"), breach.Return, maxStateMonthlyPriceReturn*100,
			)
		} else {
			obs = append(obs, stateObs...)
		}
		start = end
	}
	if len(obs) == 0 {
		return nil, fmt.Errorf("price-return index family produced zero surviving state series")
	}
	return obs, nil
}

func assembleSingleStatePriceReturnIndexObs(rows []priceReturnRow) ([]Obs, *priceReturnRow, error) {
	if len(rows) == 0 {
		return nil, nil, nil
	}
	def, ok := priceReturnIndexSeriesDef(rows[0].Region)
	if !ok {
		return nil, nil, nil
	}

	var index float64
	exists := false
	obs := make([]Obs, 0, len(rows))
	for _, row := range rows {
		if !exists {
			if row.Constituents < 5 {
				continue
			}
			index = 100
			exists = true
			obs = append(obs, Obs{Series: def, Period: row.Period, Value: 100})
			continue
		}

		if math.IsNaN(row.Return) || math.IsInf(row.Return, 0) ||
			row.Return < -maxStateMonthlyPriceReturn || row.Return > maxStateMonthlyPriceReturn {
			breach := row
			return nil, &breach, nil
		}

		index *= 1 + row.Return
		if math.IsNaN(index) || math.IsInf(index, 0) || index <= 0 {
			return nil, nil, fmt.Errorf(
				"price-return index drift for %s at %s: %.6f",
				row.Region, row.Period.Format("2006-01-02"), index,
			)
		}
		if row.Constituents < 5 {
			continue
		}
		obs = append(obs, Obs{Series: def, Period: row.Period, Value: index})
	}
	return obs, nil, nil
}

func derivePriceReturnIndexes(ctx context.Context, pool *pgxpool.Pool) ([]Obs, error) {
	rows, err := pool.Query(ctx, priceReturnIndexQuery)
	if err != nil {
		return nil, fmt.Errorf("derivation query: %w", err)
	}
	defer rows.Close()

	var monthlyPrices []monthlyPriceExposureRow
	for rows.Next() {
		var row monthlyPriceExposureRow
		if err := rows.Scan(
			&row.StockCode, &row.Region, &row.Period, &row.Close, &row.AdjustedClose,
			&row.ExposureWeight, &row.MarketCap,
		); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		monthlyPrices = append(monthlyPrices, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows: %w", err)
	}

	stockReturns, err := consecutiveStockPriceReturns(monthlyPrices)
	if err != nil {
		return nil, err
	}
	stateReturns, err := aggregateStatePriceReturns(stockReturns)
	if err != nil {
		return nil, err
	}
	obs, err := assembleStatePriceReturnIndexObs(stateReturns)
	if err != nil {
		return nil, err
	}
	if len(obs) == 0 {
		return nil, fmt.Errorf("derivation produced 0 observations — " +
			"consecutive monthly stock prices or five-stock state exposure cohorts are missing; treating as drift, not success")
	}
	return obs, nil
}
