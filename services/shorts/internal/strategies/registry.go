package strategies

import "fmt"

// Strategy ids. They are URLs (/picks/<id>), API arguments and MCP tool
// arguments, so they never change once shipped (plan §1).
const (
	IDZangerBreakout         = "zanger-breakout"
	IDCANSLIM                = "canslim"
	IDMinerviniTrendTemplate = "minervini-trend-template"
	IDCrowdedShortBreakout   = "crowded-short-breakout"
)

// Rule ids. Each id has exactly ONE meaning and one evaluation function
// (rules.go), shared by every strategy that uses it; a strategy that needs a
// different test uses a different id.
const (
	RuleGrowth        = "growth"
	RuleBase          = "base"
	RuleBreakout      = "breakout"
	RuleRegime        = "regime"
	RuleRS            = "rs"
	RuleLiquidity     = "liquidity"
	RuleEPSGrowth     = "eps_growth"
	RuleRevenueGrowth = "revenue_growth"
	RuleNearHigh      = "near_high"
	RuleRSLeader      = "rs_leader"
	RuleTrendStack    = "trend_stack"
	RuleSMA200Rising  = "sma200_rising"
	RuleAboveLow      = "above_low"
	RuleOffHigh       = "off_high"
	RuleAboveSMA50    = "above_sma50"
	RuleShortInterest = "short_interest"
	RuleDaysToCover   = "days_to_cover"
)

// Data sources a rule reads (StrategyRule.data_source).
const (
	SourceFundamentals = "stock_fundamentals"
	SourcePrices       = "stock_prices"
	SourceIndex        = "index_prices"
	SourceShorts       = "asic_shorts"
)

// Rule is one rule of a strategy: the author's version and exactly how we
// test it.
type Rule struct {
	ID         string
	Title      string
	RuleText   string // the rule in the author's terms
	Evaluation string // exactly how we test it, with thresholds
	Core       bool   // must pass for status triggered
	DataSource string
}

// Metadata describes how a strategy is meant to be used.
type Metadata struct {
	Style          string
	HoldingPeriod  string
	RiskPosture    string
	Universe       string
	RefreshCadence string
}

// Strategy is one named strategy. All of its prose lives here, once.
type Strategy struct {
	ID          string
	Name        string
	Author      string
	Tagline     string
	Description []string // 2-4 plain-text paragraphs
	Rules       []Rule
	Metadata    Metadata
	Caveats     []string // what our data cannot see (static; see CaveatsWithCoverage)
	Sources     []string

	// TriggerRules are the core rules that may still be unmet for a stock to
	// be a "setup": the breakout for breakout strategies, the new-high and
	// leadership rules for CAN SLIM and Minervini. Every other core rule must
	// pass for setup.
	TriggerRules []string

	// RegimeGates is true when the regime rule is core: a downtrend then
	// turns the verdict to "Stand aside".
	RegimeGates bool
}

// UsesFundamentals reports whether any rule reads stock_fundamentals.
func (s Strategy) UsesFundamentals() bool {
	for _, r := range s.Rules {
		if r.DataSource == SourceFundamentals {
			return true
		}
	}
	return false
}

// CoreRuleIDs returns the ids of the core rules, in rule order.
func (s Strategy) CoreRuleIDs() []string {
	var ids []string
	for _, r := range s.Rules {
		if r.Core {
			ids = append(ids, r.ID)
		}
	}
	return ids
}

// CaveatsWithCoverage returns the strategy's caveats, and for a strategy that
// reads fundamentals, a coverage line stating how many evaluated stocks have
// growth data. universe < 0 means "not measured" (ListStrategies), which
// yields the same warning without the numbers.
func (s Strategy) CaveatsWithCoverage(covered, universe int) []string {
	out := make([]string, 0, len(s.Caveats)+1)
	if s.UsesFundamentals() {
		out = append(out, CoverageCaveat(covered, universe))
	}
	return append(out, s.Caveats...)
}

// CoverageCaveat is the "fundamentals cover N stocks" line.
func CoverageCaveat(covered, universe int) string {
	const tail = "Where growth data is missing the growth rules read unknown, never pass, so those stocks cannot trigger."
	if universe <= 0 {
		return "Reported fundamentals do not yet cover every stock. " + tail
	}
	return fmt.Sprintf("Reported fundamentals cover %d of the %d stocks evaluated. %s", covered, universe, tail)
}

// Lookup returns the strategy with the given id.
func Lookup(id string) (Strategy, bool) {
	for _, s := range Registry() {
		if s.ID == id {
			return s, true
		}
	}
	return Strategy{}, false
}

// Shared prose. Written once so the four strategies cannot drift apart on
// facts about our data.
const (
	evalRegime = "Read from the S&P/ASX 200 (XJO): uptrend when the index closes above its 50-day average and the 50-day is above the 200-day; " +
		"neutral when it closes above the 200-day but that stack is not in place; downtrend when it closes below the 200-day. " +
		"Pass on uptrend or neutral, fail on downtrend, unknown when there is not enough recent index data (fewer than 200 sessions) to read the trend."
	evalLiquidity = "Pass when the average daily turnover (close times volume) over the last 20 sessions is at least A$250,000. " +
		"The same floor excludes sub-cent stocks, whose prices are stored to 2 decimal places and are too coarse to measure. " +
		"Unknown without 20 sessions of price and volume."
	evalRS3m = "Pass when the stock's 3-month return beats the S&P/ASX 200's 3-month return, that is, relative strength above zero. " +
		"Unknown without 3 months of price history."
	evalRSLeader = "Pass when the stock's 6-month return minus the S&P/ASX 200's 6-month return is in the top quartile (at or above the 75th percentile) " +
		"of every stock evaluated that day. Unknown without 6 months of price history."
	evalBreakout = "Pass when any of the last 5 sessions closed above the highest high of the 40 sessions before it, on volume at least 1.5 times the 50-day average. " +
		"That prior 40-session high is the pivot, and we report it as the level a failed breakout falls back through. " +
		"Unknown when the breakout cannot be measured from price history."

	caveatSubCent  = "Prices are stored to 2 decimal places, so sub-cent stocks cannot be measured reliably; the A$250,000 turnover floor excludes them."
	caveatEOD      = "Everything is measured on end-of-day prices after the evening sweep. We do not see intraday breakouts, the time of day a move happened, or news released after the close."
	caveatNotAdvic = "This is a screen, not a recommendation. Nothing here is financial advice."
	caveatHalfYear = "ASX companies report half-yearly and there are no quarterly totals, so growth is measured annual on annual for revenue and on trailing-twelve-month EPS where available. Figures can be months old, and small caps often arrive weeks after they file."

	metaUniverse = "ASX equities with at least 60 sessions of price history; only those with at least A$250,000 average daily turnover can trigger"
	metaCadence  = "Daily, after the evening price sweep"
)

// Registry returns the four launch strategies, freshly allocated on every
// call so a caller may not mutate the shared definitions.
func Registry() []Strategy {
	return []Strategy{
		zangerBreakout(),
		canslim(),
		minerviniTrendTemplate(),
		crowdedShortBreakout(),
	}
}

func zangerBreakout() Strategy {
	return Strategy{
		ID:      IDZangerBreakout,
		Name:    "Zanger Breakout",
		Author:  "Dan Zanger",
		Tagline: "Buy fast-growing companies as they break out of a tight base on heavy volume, and only when the market is on your side.",
		Description: []string{
			"Dan Zanger is a former swimming-pool contractor who reportedly turned about US$11,000 into more than US$18 million during the 1998 to 2000 technology boom, trading US growth stocks from his own account. " +
				"Fortune examined his trading records for a December 2000 profile, and his 29,233% gain over a single twelve-month stretch is widely reported as a world record for a personal portfolio.",
			"His method is simple to state and hard to follow. He looks for companies whose earnings and sales are growing explosively, waits for the share price to build a recognisable base " +
				"(a cup-and-handle, flat base, flag, pennant or ascending triangle), and buys as the price breaks out of that base on a surge in volume. If the breakout fails and the price slips back into the base, he sells quickly.",
			"He concentrates on a handful of leaders instead of spreading money thinly, and he reads the broad market before any single chart, because breakouts in a falling market fail far more often than breakouts in a rising one. " +
				"Winners are held while they keep acting well; losers are cut fast.",
			"Our version tests each of those ideas against ASX data we hold: reported revenue and EPS growth, a daily base-and-breakout detector on price and volume, the S&P/ASX 200 trend, and relative strength against the index. " +
				"It ranks the result hard and leads with a short list, because concentration is part of the method.",
		},
		Rules: []Rule{
			{
				ID:       RuleGrowth,
				Title:    "Explosive growth",
				RuleText: "Buy companies with explosive earnings and sales growth. The biggest winners usually show both, and the growth is often accelerating.",
				Evaluation: "Pass when the latest annual revenue is up at least 25% on the prior year, or EPS is up at least 25% on the same series a year earlier " +
					"(trailing twelve months where available, otherwise annual), or the company has swung from a net loss to a net profit. " +
					"Unknown when neither growth figure is available. A latest half-year that improved on the same half a year earlier is shown as supporting evidence but does not change the result.",
				Core:       true,
				DataSource: SourceFundamentals,
			},
			{
				ID:       RuleBase,
				Title:    "A recognisable base",
				RuleText: "Wait for the stock to build a proper base, such as a cup-and-handle, flat base, flag, pennant or ascending triangle, before buying.",
				Evaluation: "Pass when the stock has consolidated for 20 to 120 sessions since setting its high over the prior 40 sessions (the pivot), " +
					"the base is no more than 25% deep from that high to its low, and the close is at or above the base low. " +
					"Within 5 sessions of a breakout the 40-session window includes the breakout itself, so the length test is skipped and the base must still be no more than 25% deep with the close at or above its low. " +
					"We detect that a tight consolidation exists and report its depth and length; we do not classify its shape. Unknown when the base cannot be measured from price history.",
				Core:       true,
				DataSource: SourcePrices,
			},
			{
				ID:         RuleBreakout,
				Title:      "Breakout on heavy volume",
				RuleText:   "Buy as the price breaks out above the top of the base on heavy volume, well above its recent average.",
				Evaluation: evalBreakout,
				Core:       true,
				DataSource: SourcePrices,
			},
			{
				ID:         RuleRegime,
				Title:      "Read the market first",
				RuleText:   "Check the general market before buying anything. Most stocks follow the market, and breakouts fail in a falling one.",
				Evaluation: evalRegime + " A downtrend does not hide picks; it blocks triggers and turns the strategy verdict to stand aside.",
				Core:       true,
				DataSource: SourceIndex,
			},
			{
				ID:         RuleRS,
				Title:      "Relative strength",
				RuleText:   "Let winners run. The leaders of a move outperform the market on the way up.",
				Evaluation: evalRS3m,
				Core:       false,
				DataSource: SourcePrices,
			},
			{
				ID:         RuleLiquidity,
				Title:      "Liquid enough to trade",
				RuleText:   "Trade liquid leaders that can be bought at the breakout and sold quickly if it fails.",
				Evaluation: evalLiquidity,
				Core:       true,
				DataSource: SourcePrices,
			},
		},
		Metadata: Metadata{
			Style:          "momentum-breakout",
			HoldingPeriod:  "Weeks to months",
			RiskPosture:    "Sell quickly if the breakout fails and the price closes back inside the base, below the pivot.",
			Universe:       metaUniverse,
			RefreshCadence: metaCadence,
		},
		Caveats: []string{
			"We detect a tight base; we do not classify cup-and-handle, flag, pennant or triangle shapes, so a base that passes may not be one Zanger himself would trade.",
			caveatHalfYear,
			caveatEOD,
			"Where to set a stop, how much to buy and when to sell a winner are the trader's decisions. We report the pivot, not a stop or a target.",
			caveatSubCent,
			caveatNotAdvic,
		},
		Sources: []string{
			"Fortune magazine, December 2000: profile of Dan Zanger and his verified trading record.",
			"Guinness record note: the 29,233% one-year return is widely reported as a world record for a personal portfolio; we cite it as reported.",
			"Dan Zanger, The Zanger Report (chartpattern.com): his published chart patterns and trading rules.",
		},
		TriggerRules: []string{RuleBreakout},
		RegimeGates:  true,
	}
}

func canslim() Strategy {
	return Strategy{
		ID:      IDCANSLIM,
		Name:    "CAN SLIM",
		Author:  "William J. O'Neil",
		Tagline: "Buy market leaders with surging earnings as they reach new highs, and only in a confirmed market uptrend.",
		Description: []string{
			"William J. O'Neil founded Investor's Business Daily and the research firm William O'Neil + Co. He built CAN SLIM from a study of the biggest US stock winners going back to the 1950s, " +
				"looking for what they had in common before their largest price advances, and set it out in How to Make Money in Stocks, first published in 1988.",
			"Each letter is one trait: C, current quarterly earnings up sharply; A, strong annual earnings growth; N, something new, whether a product, management or a new price high; " +
				"S, supply and demand, seen in volume; L, a leader rather than a laggard; I, institutional sponsorship; and M, market direction. " +
				"The traits work together: a strong company in a weak market, or a cheap laggard, is not a CAN SLIM stock.",
			"Our version maps the letters that ASX data can support. EPS growth stands in for C and A, closeness to the 52-week high stands in for N, relative strength against the rest of the market stands in for L, " +
				"the S&P/ASX 200 trend is M, and a turnover floor is a thin proxy for S. Institutional sponsorship (I) is not evaluated.",
		},
		Rules: []Rule{
			{
				ID:       RuleEPSGrowth,
				Title:    "Earnings growth (C and A)",
				RuleText: "Current quarterly earnings per share up at least 25% on the same quarter a year earlier, backed by strong annual earnings growth.",
				Evaluation: "Pass when EPS is up at least 25% on the same series a year earlier (trailing twelve months where available, otherwise annual), " +
					"or the company has swung from a net loss to a net profit. ASX companies report half-yearly, not quarterly, so a trailing-twelve-month comparison is the closest honest proxy. " +
					"Unknown when there is no EPS growth figure.",
				Core:       true,
				DataSource: SourceFundamentals,
			},
			{
				ID:         RuleRevenueGrowth,
				Title:      "Sales growth",
				RuleText:   "Earnings growth should be backed by strong sales growth, not just cost cutting.",
				Evaluation: "Pass when the latest annual revenue is up at least 20% on the prior year. Unknown when either year is missing.",
				Core:       false,
				DataSource: SourceFundamentals,
			},
			{
				ID:         RuleNearHigh,
				Title:      "New highs (N)",
				RuleText:   "Buy stocks emerging to new price highs from a sound base, not stocks near their lows.",
				Evaluation: "Pass when the close is within 5% of the 52-week high. Unknown without a 52-week high.",
				Core:       true,
				DataSource: SourcePrices,
			},
			{
				ID:         RuleRSLeader,
				Title:      "Leader, not laggard (L)",
				RuleText:   "Buy the leading stocks in leading groups. O'Neil looks for a relative strength rating of 80 or more.",
				Evaluation: evalRSLeader,
				Core:       true,
				DataSource: SourcePrices,
			},
			{
				ID:         RuleRegime,
				Title:      "Market direction (M)",
				RuleText:   "Three out of four stocks follow the market's trend, so buy only when the market is in a confirmed uptrend.",
				Evaluation: evalRegime + " A downtrend does not hide picks; it blocks triggers and turns the strategy verdict to stand aside.",
				Core:       true,
				DataSource: SourceIndex,
			},
			{
				ID:         RuleLiquidity,
				Title:      "Supply and demand (S)",
				RuleText:   "Big winners show demand in their trading volume. Thinly traded stocks are hard to buy and harder to sell.",
				Evaluation: evalLiquidity,
				Core:       true,
				DataSource: SourcePrices,
			},
		},
		Metadata: Metadata{
			Style:          "growth-momentum",
			HoldingPeriod:  "Months",
			RiskPosture:    "O'Neil's rule: sell any stock that falls 7% to 8% below the purchase price, without exception.",
			Universe:       metaUniverse,
			RefreshCadence: metaCadence,
		},
		Caveats: []string{
			"There are no quarterly earnings for ASX companies, so trailing-twelve-month EPS stands in for the C in CAN SLIM, and it moves only when a half-year or full-year result lands.",
			"Institutional sponsorship (I) is not evaluated; we hold no fund ownership data.",
			"New products, new management and industry-group leadership are not evaluated.",
			"Relative strength is ranked against the ASX stocks we evaluate, not IBD's proprietary rating of US stocks, and the cut-off is the top quartile, slightly looser than O'Neil's 80.",
			caveatEOD,
			caveatSubCent,
			caveatNotAdvic,
		},
		Sources: []string{
			"William J. O'Neil, How to Make Money in Stocks (McGraw-Hill; first published 1988).",
			"Investor's Business Daily: the CAN SLIM investing system.",
		},
		TriggerRules: []string{RuleNearHigh, RuleRSLeader},
		RegimeGates:  true,
	}
}

func minerviniTrendTemplate() Strategy {
	return Strategy{
		ID:      IDMinerviniTrendTemplate,
		Name:    "Minervini Trend Template",
		Author:  "Mark Minervini",
		Tagline: "Consider only stocks already in a Stage 2 uptrend: above rising long-term averages, well off their lows and close to their highs.",
		Description: []string{
			"Mark Minervini is a US trader who won the 1997 US Investing Championship and later wrote Trade Like a Stock Market Wizard (2013). " +
				"His approach starts with a filter he calls the Trend Template: a set of price conditions a stock must meet before he will consider it at all.",
			"The template keeps you out of stocks in the wrong stage of their cycle. It demands that the price is above its 150-day and 200-day moving averages, that the 200-day is itself rising, " +
				"that the stock is well up from its 52-week low and not far from its 52-week high, and that it is outperforming the market. A stock failing any of these is, in his terms, not in a Stage 2 uptrend.",
			"Our version is pure price and needs no fundamentals, so it covers every stock with enough history. It finds candidates, not entries: " +
				"Minervini still waits for a low-risk entry point, typically a volatility contraction pattern, before he buys.",
		},
		Rules: []Rule{
			{
				ID:         RuleTrendStack,
				Title:      "Above rising averages",
				RuleText:   "The price is above both the 150-day and the 200-day moving averages, and the 150-day is above the 200-day.",
				Evaluation: "Pass when the close is above the 150-day simple moving average and the 150-day is above the 200-day. Unknown without 200 sessions of price history.",
				Core:       true,
				DataSource: SourcePrices,
			},
			{
				ID:         RuleSMA200Rising,
				Title:      "200-day trending up",
				RuleText:   "The 200-day moving average has been trending up for at least one month, and preferably four to five months.",
				Evaluation: "Pass when today's 200-day simple moving average is above its value about one month (21 sessions) earlier. Unknown when either value is missing.",
				Core:       true,
				DataSource: SourcePrices,
			},
			{
				ID:         RuleAboveLow,
				Title:      "Well off the low",
				RuleText:   "The price is at least 30% above its 52-week low.",
				Evaluation: "Pass when the close is at least 1.3 times the 52-week low. Unknown without a 52-week low.",
				Core:       true,
				DataSource: SourcePrices,
			},
			{
				ID:         RuleOffHigh,
				Title:      "Near the high",
				RuleText:   "The price is within 25% of its 52-week high; the closer to a new high, the better.",
				Evaluation: "Pass when the close is no more than 25% below the 52-week high. Unknown without a 52-week high.",
				Core:       true,
				DataSource: SourcePrices,
			},
			{
				ID:         RuleRSLeader,
				Title:      "Relative strength",
				RuleText:   "The relative strength ranking is no less than 70, and preferably in the 80s or 90s.",
				Evaluation: evalRSLeader,
				Core:       true,
				DataSource: SourcePrices,
			},
			{
				ID:         RuleAboveSMA50,
				Title:      "Above the 50-day",
				RuleText:   "The price is trading above the 50-day moving average.",
				Evaluation: "Pass when the close is above the 50-day simple moving average. Unknown without 50 sessions of price history.",
				Core:       false,
				DataSource: SourcePrices,
			},
			{
				ID:         RuleLiquidity,
				Title:      "Liquid enough to trade",
				RuleText:   "Focus on stocks with enough volume for institutions to accumulate them, which is what drives a sustained advance.",
				Evaluation: evalLiquidity,
				Core:       true,
				DataSource: SourcePrices,
			},
		},
		Metadata: Metadata{
			Style:          "trend-following",
			HoldingPeriod:  "Weeks to months",
			RiskPosture:    "Keep losses small: Minervini caps a loss at about 10% and aims for an average loss well below that.",
			Universe:       metaUniverse,
			RefreshCadence: metaCadence,
		},
		Caveats: []string{
			"We do not test Minervini's condition that the 50-day average sits above the 150-day and 200-day averages; we test the close above the 50-day instead.",
			"The 200-day trend is tested over one month, the minimum he allows, not the four to five months he prefers.",
			"Relative strength is ranked against the ASX stocks we evaluate. The top-quartile cut-off (roughly a ranking of 75) clears his minimum of 70 but not the 80s and 90s he prefers.",
			"The template finds candidates only. We do not detect the volatility contraction pattern he uses to time an entry.",
			caveatEOD,
			caveatSubCent,
			caveatNotAdvic,
		},
		Sources: []string{
			"Mark Minervini, Trade Like a Stock Market Wizard (McGraw-Hill, 2013).",
			"Mark Minervini, Think and Trade Like a Champion (2017).",
		},
		TriggerRules: []string{RuleOffHigh, RuleRSLeader},
		RegimeGates:  false,
	}
}

func crowdedShortBreakout() Strategy {
	return Strategy{
		ID:      IDCrowdedShortBreakout,
		Name:    "Crowded-Short Breakout",
		Author:  "Shorted",
		Tagline: "Heavily shorted ASX stocks breaking out on volume, where short sellers may be forced to buy back.",
		Description: []string{
			"This is our own strategy, built on the dataset Shorted exists to publish: the daily short positions that short sellers must report to ASIC. " +
				"It looks for the moment a crowded short trade starts to go wrong for the people in it.",
			"When a large share of a company's stock has been sold short and the price breaks out of a base on heavy volume, short sellers face mounting losses. " +
				"Buying shares back to close those positions adds demand at exactly the moment the price is already rising, and the more days of normal trading it would take for every short seller to cover, the sharper that squeeze can be.",
			"The screen requires meaningful short interest (at least 5% of shares on issue) and a fresh breakout on volume. Days to cover, relative strength and the market trend add to the score. " +
				"Heavy short interest is not a buy signal on its own: short sellers are often right, and a crowded short with no breakout is a warning, not an opportunity.",
		},
		Rules: []Rule{
			{
				ID:         RuleShortInterest,
				Title:      "Crowded short",
				RuleText:   "A large share of the company's stock has been sold short.",
				Evaluation: "Pass when the latest ASIC reported short position is at least 5% of shares on issue. Fail when it is lower or when no short position is reported.",
				Core:       true,
				DataSource: SourceShorts,
			},
			{
				ID:         RuleDaysToCover,
				Title:      "Days to cover",
				RuleText:   "Short sellers would need many days of normal trading to buy their shares back.",
				Evaluation: "Pass when the reported short position divided by the 20-day average daily volume is at least 5 days. Fail when no short position is reported; unknown when there is no recent volume to divide by.",
				Core:       false,
				DataSource: SourceShorts,
			},
			{
				ID:         RuleBreakout,
				Title:      "Breakout on heavy volume",
				RuleText:   "The price breaks out of a base on heavy volume, the moment covering pressure starts to build.",
				Evaluation: evalBreakout,
				Core:       true,
				DataSource: SourcePrices,
			},
			{
				ID:         RuleRegime,
				Title:      "Market direction",
				RuleText:   "A rising market adds buyers. Squeezes can still run in a weak market, but they follow through less often.",
				Evaluation: evalRegime + " Here it adds to the score but does not block a trigger.",
				Core:       false,
				DataSource: SourceIndex,
			},
			{
				ID:         RuleLiquidity,
				Title:      "Liquid enough to trade",
				RuleText:   "Squeezes move fast, so the stock must trade enough to get in and out.",
				Evaluation: evalLiquidity,
				Core:       true,
				DataSource: SourcePrices,
			},
			{
				ID:         RuleRS,
				Title:      "Relative strength",
				RuleText:   "The stock is already outperforming the market.",
				Evaluation: evalRS3m,
				Core:       false,
				DataSource: SourcePrices,
			},
		},
		Metadata: Metadata{
			Style:          "short-squeeze-breakout",
			HoldingPeriod:  "Days to weeks",
			RiskPosture:    "Exit if the price closes back inside the base, below the pivot; squeezes reverse as quickly as they start.",
			Universe:       metaUniverse + ", and a reported short position of at least 5% to trigger",
			RefreshCadence: metaCadence,
		},
		Caveats: []string{
			"ASIC publishes short positions four trading days after the date they are held, so the short figure is always a few days old.",
			"Reported short positions are net and cover only reportable positions; they are not every short sale in the market.",
			"Days to cover divides the latest reported short position by a 20-day average volume, so it moves as either changes.",
			"Heavy short interest often reflects real problems at the company. A breakout can fail, and a stock short sellers are right about can keep falling.",
			caveatEOD,
			caveatSubCent,
			caveatNotAdvic,
		},
		Sources: []string{
			"ASIC short position reports, published daily for ASX-listed products.",
			"Shorted.com.au: ASIC short position history and days-to-cover calculations.",
		},
		TriggerRules: []string{RuleBreakout},
		RegimeGates:  false,
	}
}
