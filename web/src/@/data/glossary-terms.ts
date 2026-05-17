export interface GlossaryTerm {
  term: string;
  slug: string;
  definition: string;
  related: string[];
}

export interface GlossaryCategory {
  category: string;
  terms: GlossaryTerm[];
}

function createSlug(term: string): string {
  return term
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export const glossaryTerms: GlossaryCategory[] = [
  {
    category: "Core Concepts",
    terms: [
      {
        term: "Short Selling",
        slug: createSlug("Short Selling"),
        definition:
          "A trading strategy where an investor borrows shares and sells them, hoping to buy them back at a lower price. The investor profits if the stock price falls and loses money if it rises.",
        related: ["Short Position", "Securities Lending", "Short Squeeze"],
      },
      {
        term: "Short Position",
        slug: createSlug("Short Position"),
        definition:
          "The number of shares of a particular stock that have been sold short but not yet covered or closed out. On the ASX, significant short positions must be reported to ASIC.",
        related: ["Short Interest", "ASIC"],
      },
      {
        term: "Short Interest",
        slug: createSlug("Short Interest"),
        definition:
          "The percentage of a company's total shares on issue that are currently held as short positions. Expressed as a percentage, e.g., 10% short interest means 10% of all shares are shorted.",
        related: ["Short Position", "Shares on Issue"],
      },
      {
        term: "Short Squeeze",
        slug: createSlug("Short Squeeze"),
        definition:
          "A rapid increase in a stock's price caused by short sellers rushing to cover their positions. When many shorts try to buy shares simultaneously, it can drive the price up dramatically, forcing more shorts to cover.",
        related: ["Short Covering", "Short Position"],
      },
    ],
  },
  {
    category: "ASIC & Reporting",
    terms: [
      {
        term: "ASIC",
        slug: createSlug("ASIC"),
        definition:
          "The Australian Securities and Investments Commission - Australia's corporate regulator. ASIC collects and publishes aggregated short position reports from market participants.",
        related: ["T+4 Delay", "Short Position"],
      },
      {
        term: "T+4 Delay",
        slug: createSlug("T+4 Delay"),
        definition:
          "ASIC publishes short position data with a four trading day delay. For example, Monday's short positions are published on Friday. This delay is built into the reporting system.",
        related: ["ASIC", "Short Position"],
      },
      {
        term: "Reporting Threshold",
        slug: createSlug("Reporting Threshold"),
        definition:
          "Market participants must report short positions to ASIC when they exceed $100,000 or 0.01% of the company's issued capital, whichever is less.",
        related: ["ASIC", "Short Position"],
      },
      {
        term: "Aggregated Short Position",
        slug: createSlug("Aggregated Short Position"),
        definition:
          "The total short position across all market participants, published by ASIC. Individual positions are not disclosed to protect trader confidentiality.",
        related: ["ASIC", "Short Position"],
      },
      {
        term: "Corporations Act 2001",
        slug: createSlug("Corporations Act 2001"),
        definition:
          "The primary Australian legislation governing short selling. Key sections include s1020B (prohibiting naked short selling), s1020AB (short sale transaction reporting to ASX), and s1020AC (net short position reporting to ASIC). It establishes the legal framework for covered short selling and disclosure obligations.",
        related: ["ASIC", "Regulatory Guide 196", "Net Short Position"],
      },
      {
        term: "Regulatory Guide 196",
        slug: createSlug("Regulatory Guide 196"),
        definition:
          "ASIC Regulatory Guide 196 (RG 196) provides guidance on short selling disclosure and reporting obligations in Australia. It outlines the 0.01% or $100,000 reporting threshold, T+4 publication delay, and the distinction between covered and naked short selling under the Corporations Act 2001.",
        related: ["ASIC", "Corporations Act 2001", "Reporting Threshold"],
      },
      {
        term: "Net Short Position",
        slug: createSlug("Net Short Position"),
        definition:
          "The overall short exposure calculated by netting long positions against short positions in the same security. Australia uses net short position reporting under ASIC Regulatory Guide 196, meaning only the net directional exposure is reported, not the gross short position.",
        related: ["Short Position", "ASIC", "Reporting Threshold"],
      },
      {
        term: "Section 1020B Products",
        slug: createSlug("Section 1020B Products"),
        definition:
          "Financial products subject to the naked short selling prohibition under section 1020B of the Corporations Act 2001. Includes shares, debentures, and other financial products traded on licensed markets like the ASX. Sellers must have a presently exercisable right to vest these products before selling short.",
        related: ["Corporations Act 2001", "Short Selling", "ASIC"],
      },
      {
        term: "ASX Short Sales Report",
        slug: createSlug("ASX Short Sales Report"),
        definition:
          "The daily publication by ASIC containing aggregated short position data for all ASX-listed securities. Includes product code, product name, reported short positions, total shares in issue, and short position percentage. Published with a T+4 trading day delay.",
        related: ["ASIC", "T+4 Delay", "Net Short Position"],
      },
    ],
  },
  {
    category: "Trading Mechanics",
    terms: [
      {
        term: "Securities Lending",
        slug: createSlug("Securities Lending"),
        definition:
          "The process by which shares are borrowed from institutional holders (like superannuation funds) to facilitate short selling. Lenders receive a fee for making their shares available.",
        related: ["Short Selling", "Borrowing Cost"],
      },
      {
        term: "Short Covering",
        slug: createSlug("Short Covering"),
        definition:
          "The process of closing out a short position by buying back the shares that were previously sold short. Also called 'covering' or 'closing a short'.",
        related: ["Short Squeeze", "Short Position"],
      },
      {
        term: "Days to Cover",
        slug: createSlug("Days to Cover"),
        definition:
          "The number of days it would take for all short sellers to cover their positions based on average daily trading volume. Calculated as: Short Interest ÷ Average Daily Volume.",
        related: ["Short Interest", "Short Squeeze"],
      },
      {
        term: "Borrowing Cost",
        slug: createSlug("Borrowing Cost"),
        definition:
          "The interest rate charged to borrow shares for short selling. Hard-to-borrow stocks have higher borrowing costs, which can exceed 50% annually for heavily shorted stocks.",
        related: ["Securities Lending", "Short Selling"],
      },
      {
        term: "Margin Call",
        slug: createSlug("Margin Call"),
        definition:
          "A demand from a broker for additional funds when a short position moves against the trader. If the stock price rises significantly, the short seller must deposit more collateral.",
        related: ["Short Selling", "Short Squeeze"],
      },
    ],
  },
  {
    category: "Analysis Terms",
    terms: [
      {
        term: "Bearish",
        slug: createSlug("Bearish"),
        definition:
          "A negative outlook on a stock or the market. Short sellers are bearish as they profit when prices fall. High short interest is often considered a bearish indicator.",
        related: ["Short Selling", "Short Interest"],
      },
      {
        term: "Bullish",
        slug: createSlug("Bullish"),
        definition:
          "A positive outlook expecting prices to rise. Some traders view high short interest as bullish, believing a short squeeze could push prices higher.",
        related: ["Short Squeeze"],
      },
      {
        term: "Shares on Issue",
        slug: createSlug("Shares on Issue"),
        definition:
          "The total number of shares of a company that have been issued and are outstanding. Used as the denominator when calculating short interest percentage.",
        related: ["Short Interest"],
      },
      {
        term: "Float",
        slug: createSlug("Float"),
        definition:
          "The number of shares available for public trading, excluding restricted shares held by insiders. Short interest relative to float can be higher than relative to total shares.",
        related: ["Short Interest", "Shares on Issue"],
      },
      {
        term: "Short Interest Ratio",
        slug: createSlug("Short Interest Ratio"),
        definition:
          "Another name for days to cover. A higher ratio suggests it will take longer for shorts to exit their positions, potentially increasing squeeze risk.",
        related: ["Days to Cover", "Short Squeeze"],
      },
    ],
  },
  {
    category: "Market Participants",
    terms: [
      {
        term: "Hedge Fund",
        slug: createSlug("Hedge Fund"),
        definition:
          "Investment funds that use various strategies including short selling. Hedge funds are major participants in ASX short selling activity.",
        related: ["Short Selling", "Securities Lending"],
      },
      {
        term: "Market Maker",
        slug: createSlug("Market Maker"),
        definition:
          "Financial institutions that provide liquidity by buying and selling securities. Market makers may have short positions as part of their market-making activities.",
        related: ["Short Position"],
      },
      {
        term: "Prime Broker",
        slug: createSlug("Prime Broker"),
        definition:
          "Financial institutions that provide services to hedge funds including securities lending for short selling. They facilitate the borrowing of shares.",
        related: ["Securities Lending", "Hedge Fund"],
      },
    ],
  },
  {
    category: "Short Selling Mechanics",
    terms: [
      {
        term: "Locate",
        slug: createSlug("Locate"),
        definition:
          "The process of confirming a lender for shares before executing a short sale. Australian law (Corporations Act s1020B) requires sellers to have a securities lending arrangement in place before they short — a 'locate' is the broker's confirmation that shares are available to borrow.",
        related: ["Securities Lending", "Naked Short Selling"],
      },
      {
        term: "Recall",
        slug: createSlug("Recall"),
        definition:
          "When a securities lender demands the return of shares lent out for short selling, forcing the borrower to close their short position or find shares from a new lender. Recalls often happen around dividend records, AGM voting, and corporate actions.",
        related: ["Securities Lending", "Short Squeeze", "Short Covering"],
      },
      {
        term: "Rebate Rate",
        slug: createSlug("Rebate Rate"),
        definition:
          "The interest a short seller earns on cash collateral posted to borrow shares, less the borrow fee charged by the lender. For hard-to-borrow stocks the rebate can be negative — the short seller pays to hold the position.",
        related: ["Borrow Fee", "Hard-to-Borrow", "Securities Lending"],
      },
      {
        term: "Borrow Fee",
        slug: createSlug("Borrow Fee"),
        definition:
          "The annualised cost of borrowing shares to maintain a short position, expressed as a percentage of the position's market value. Highly-shorted or low-float ASX stocks can carry borrow fees of 20-50% or more.",
        related: ["Rebate Rate", "Hard-to-Borrow", "Utilisation"],
      },
      {
        term: "Hard-to-Borrow",
        slug: createSlug("Hard-to-Borrow"),
        definition:
          "Stocks where shares for short-selling are scarce, driving up borrow fees and increasing recall risk. Often coincides with a building short squeeze setup. On the ASX, hard-to-borrow status is broker-defined and not publicly listed.",
        related: ["Borrow Fee", "Short Squeeze", "Utilisation"],
      },
      {
        term: "Easy-to-Borrow",
        slug: createSlug("Easy-to-Borrow"),
        definition:
          "Highly-liquid stocks where shares are readily available to short with minimal borrow fees. Most ASX 200 large caps are easy-to-borrow under normal conditions.",
        related: ["Borrow Fee", "Securities Lending"],
      },
      {
        term: "Stock Loan",
        slug: createSlug("Stock Loan"),
        definition:
          "A transaction in which one party lends shares to another in exchange for collateral (usually cash plus a fee). The borrower can then sell those shares short. Standard documentation uses the Global Master Securities Lending Agreement (GMSLA).",
        related: ["Securities Lending", "Locate", "Rebate Rate"],
      },
    ],
  },
  {
    category: "Ratios & Metrics",
    terms: [
      {
        term: "Utilisation",
        slug: createSlug("Utilisation"),
        definition:
          "The percentage of a stock's lendable float currently out on loan. High utilisation (>90%) indicates supply scarcity and rising borrow fees — a classic precursor to short-squeeze conditions.",
        related: ["Hard-to-Borrow", "Borrow Fee", "Free Float"],
      },
      {
        term: "Short Interest Ratio",
        slug: createSlug("Short Interest Ratio"),
        definition:
          "Synonym for Days to Cover — measures how many days of average trading volume are needed to close every short position. Widely used in US markets and increasingly in ASX analysis.",
        related: ["Days to Cover", "Short Interest"],
      },
      {
        term: "Average Daily Volume",
        slug: createSlug("Average Daily Volume"),
        definition:
          "The mean number of shares traded per day over a defined window (typically 30 days). ADV is the denominator in Days to Cover and a key liquidity gauge.",
        related: ["Days to Cover", "Liquidity"],
      },
      {
        term: "Free Float",
        slug: createSlug("Free Float"),
        definition:
          "The portion of a company's shares available for public trading, excluding insider, strategic, and locked-up holdings. Low free float amplifies short-squeeze potential because shares are harder to source for borrowing.",
        related: ["Utilisation", "Hard-to-Borrow", "Liquidity"],
      },
      {
        term: "Liquidity",
        slug: createSlug("Liquidity"),
        definition:
          "How easily a stock can be bought or sold without moving the price. Measured by spread, depth, and volume. ASX 200 stocks are typically highly liquid; small and micro-caps less so.",
        related: ["Average Daily Volume", "Free Float"],
      },
      {
        term: "Beta",
        slug: createSlug("Beta"),
        definition:
          "A measure of a stock's volatility relative to the broader market (e.g., S&P/ASX 200). Beta of 1 moves with the market; >1 is more volatile; <1 less. High-beta names often attract heavier short interest.",
        related: ["Volatility"],
      },
      {
        term: "Volatility",
        slug: createSlug("Volatility"),
        definition:
          "The degree of price variation over time, typically measured as the annualised standard deviation of returns. Higher volatility increases option premiums and short-selling risk.",
        related: ["Beta", "Implied Volatility"],
      },
    ],
  },
  {
    category: "Market Structure",
    terms: [
      {
        term: "T+2 Settlement",
        slug: createSlug("T+2 Settlement"),
        definition:
          "The ASX settles cash-equity trades two business days after execution. The buyer receives shares and the seller receives cash on T+2. Short sellers must deliver borrowed shares by T+2 to avoid a fail-to-deliver.",
        related: ["T+4 Delay", "Fail to Deliver"],
      },
      {
        term: "Opening Auction",
        slug: createSlug("Opening Auction"),
        definition:
          "The 10:00am AEST auction that sets ASX opening prices. Pre-open orders accumulate from 7:00am and the matching algorithm calculates a single clearing price. Short sales typically aren't permitted in the opening auction.",
        related: ["Market on Close", "ASX Trade"],
      },
      {
        term: "Market on Close",
        slug: createSlug("Market on Close"),
        definition:
          "The 4:10pm AEST closing auction that sets official ASX closing prices. MOC orders execute only at the closing print and are widely used for benchmark trading and index rebalancing.",
        related: ["Opening Auction", "ASX Trade"],
      },
      {
        term: "ASX Trade",
        slug: createSlug("ASX Trade"),
        definition:
          "The matching engine that runs continuous trading on the ASX and Cboe Australia (formerly Chi-X). Handles ~$5B in daily turnover during normal session hours 10:00–16:00 AEST.",
        related: ["Cboe Australia", "Market on Close"],
      },
      {
        term: "Cboe Australia",
        slug: createSlug("Cboe Australia"),
        definition:
          "The alternative ASX trading venue (rebranded from Chi-X Australia in 2022). Operates a competing lit order book — ASX-listed securities trade on both venues with a single best-bid-offer aggregated across them.",
        related: ["ASX Trade", "Dark Pool"],
      },
      {
        term: "Dark Pool",
        slug: createSlug("Dark Pool"),
        definition:
          "Private trading venues where buy and sell orders are matched without pre-trade transparency. Used by institutions to execute large block trades without moving the lit market. ASIC requires dark trades over certain size thresholds to be reported.",
        related: ["Cboe Australia"],
      },
      {
        term: "Fail to Deliver",
        slug: createSlug("Fail to Deliver"),
        definition:
          "A trade that does not settle on T+2 because the seller cannot deliver shares. Persistent fails can indicate naked short selling. The ASX publishes fail statistics and ASIC investigates suspected naked short cases.",
        related: ["T+2 Settlement", "Naked Short Selling"],
      },
    ],
  },
  {
    category: "Risk & Position Management",
    terms: [
      {
        term: "Drawdown",
        slug: createSlug("Drawdown"),
        definition:
          "The peak-to-trough decline in an investment's value, expressed as a percentage. Short sellers track adverse drawdowns to size positions and set stop-losses.",
        related: ["Volatility", "Stop Loss", "Position Sizing"],
      },
      {
        term: "Stop Loss",
        slug: createSlug("Stop Loss"),
        definition:
          "An order that automatically closes a position once a defined adverse price is reached. For a short, a buy-stop above the entry price caps the loss. Cascading stop-losses contribute to squeeze severity.",
        related: ["Short Squeeze", "Position Sizing"],
      },
      {
        term: "Position Sizing",
        slug: createSlug("Position Sizing"),
        definition:
          "Determining how much capital to allocate to a single position based on conviction, volatility, and account risk tolerance. Conservative short sellers cap positions at 1-3% of portfolio NAV.",
        related: ["Drawdown", "Risk-Reward Ratio"],
      },
      {
        term: "Risk-Reward Ratio",
        slug: createSlug("Risk-Reward Ratio"),
        definition:
          "The ratio of potential loss to potential gain on a trade. For shorts, the maximum gain is bounded (price can only fall to zero) while the loss is unbounded (price can rise indefinitely) — making R/R discipline especially important.",
        related: ["Stop Loss", "Position Sizing"],
      },
      {
        term: "Hedging",
        slug: createSlug("Hedging"),
        definition:
          "Taking an offsetting position to reduce risk in another holding. Pair trades (long one stock, short a peer) are a common hedge against sector or market beta.",
        related: ["Beta"],
      },
      {
        term: "Gamma Squeeze",
        slug: createSlug("Gamma Squeeze"),
        definition:
          "A rapid stock-price spike driven by option market-makers hedging short-call exposure. As the share price rises, dealers must buy more underlying to remain delta-neutral, accelerating the squeeze. The 2021 US meme-stock rally was the textbook example.",
        related: ["Short Squeeze", "Implied Volatility"],
      },
      {
        term: "Implied Volatility",
        slug: createSlug("Implied Volatility"),
        definition:
          "The market's forward-looking estimate of a stock's volatility, derived from option prices. Elevated IV signals expected price swings — useful for sizing short positions and timing squeeze setups.",
        related: ["Volatility", "Gamma Squeeze"],
      },
    ],
  },
  {
    category: "Behavioural Finance",
    terms: [
      {
        term: "Capitulation",
        slug: createSlug("Capitulation"),
        definition:
          "Mass surrender by longs after a sustained decline, marked by accelerating volume and panic selling. Short sellers often cover into capitulation lows, as the move has likely exhausted.",
        related: ["Panic Selling", "Short Covering"],
      },
      {
        term: "Panic Selling",
        slug: createSlug("Panic Selling"),
        definition:
          "Heavy, emotion-driven liquidation of holdings triggered by sharp price declines or bad news. Often associated with capitulation and short-seller profits.",
        related: ["Capitulation"],
      },
      {
        term: "FOMO",
        slug: createSlug("FOMO"),
        definition:
          "Fear of missing out — the behavioural bias driving investors to chase rising prices. FOMO buying into a heavily-shorted stock can ignite a short squeeze as price-insensitive shorts get forced out.",
        related: ["Short Squeeze", "Herding"],
      },
      {
        term: "Herding",
        slug: createSlug("Herding"),
        definition:
          "The tendency of investors to follow the crowd rather than independent analysis. Herding amplifies trends and inflates bubbles, which contrarian short sellers seek to fade.",
        related: ["FOMO", "Contrarian"],
      },
      {
        term: "Contrarian",
        slug: createSlug("Contrarian"),
        definition:
          "An investment style that bets against prevailing sentiment. Short selling overvalued momentum names is a classic contrarian position.",
        related: ["Herding", "FOMO"],
      },
    ],
  },
  {
    category: "Australian Market & Macro",
    terms: [
      {
        term: "RBA Cash Rate",
        slug: createSlug("RBA Cash Rate"),
        definition:
          "The Reserve Bank of Australia's policy interest rate, set monthly by the RBA Board. Influences borrowing costs across the economy and the rebate rate short sellers earn on cash collateral.",
        related: ["Rebate Rate"],
      },
      {
        term: "Franking Credits",
        slug: createSlug("Franking Credits"),
        definition:
          "Tax credits attached to Australian dividends representing corporate tax already paid. Recipients reduce their personal tax liability by the franking-credit amount. Short sellers must compensate lenders for any franking value missed on the loaned stock — a 'frank' or 'manufactured dividend' adjustment.",
        related: ["Manufactured Dividend", "Dividend"],
      },
      {
        term: "Manufactured Dividend",
        slug: createSlug("Manufactured Dividend"),
        definition:
          "A cash payment a short seller makes to the share lender to compensate for dividends paid during the loan period. ATO rules govern the tax treatment, and the obligation often spikes around the ex-dividend date.",
        related: ["Franking Credits", "Ex-Dividend Date"],
      },
      {
        term: "ASX 200",
        slug: createSlug("ASX 200"),
        definition:
          "Australia's benchmark equity index, comprising the 200 largest ASX-listed companies by float-adjusted market cap. Rebalanced quarterly by S&P. Index inclusion drives flows from passive ETFs and superannuation funds.",
        related: ["Index Rebalance"],
      },
      {
        term: "Index Rebalance",
        slug: createSlug("Index Rebalance"),
        definition:
          "Quarterly adjustment of index constituents and weights. Anticipated additions tend to rally and deletions tend to fall, creating short-selling opportunities around index-effective dates.",
        related: ["ASX 200"],
      },
    ],
  },
  {
    category: "Corporate Actions",
    terms: [
      {
        term: "Ex-Dividend Date",
        slug: createSlug("Ex-Dividend Date"),
        definition:
          "The first trading day a stock trades without the right to its declared dividend. Buyers on or after this date do not receive the dividend. Stocks typically drop by the dividend amount on the ex-date, which short sellers must compensate lenders for.",
        related: ["Manufactured Dividend", "Dividend"],
      },
      {
        term: "Dividend",
        slug: createSlug("Dividend"),
        definition:
          "A cash distribution from a company to shareholders, usually paid semi-annually for ASX stocks. Most ASX dividends carry franking credits.",
        related: ["Franking Credits", "Ex-Dividend Date"],
      },
      {
        term: "Rights Issue",
        slug: createSlug("Rights Issue"),
        definition:
          "An offer letting existing shareholders buy new shares at a discount, pro-rata to their holding. Rights issues dilute non-participating holders and often pressure the share price — favourable conditions for short sellers.",
        related: ["Share Purchase Plan", "Capital Raising"],
      },
      {
        term: "Share Purchase Plan",
        slug: createSlug("Share Purchase Plan"),
        definition:
          "An SPP is a placement to retail shareholders capped at $30,000 per holder. Typically priced at a discount to market and used alongside institutional placements to top up capital.",
        related: ["Rights Issue", "Capital Raising"],
      },
      {
        term: "Capital Raising",
        slug: createSlug("Capital Raising"),
        definition:
          "Any issuance of new equity, including placements, rights issues, SPPs, and convertibles. Short sellers watch for raisings as they signal balance-sheet stress and often dilute existing holders.",
        related: ["Rights Issue", "Share Purchase Plan"],
      },
      {
        term: "Buyback",
        slug: createSlug("Buyback"),
        definition:
          "A company repurchases its own shares from the market, reducing shares on issue and lifting EPS. Buybacks can short-squeeze a heavily-shorted name by removing supply.",
        related: ["Short Squeeze"],
      },
      {
        term: "Profit Warning",
        slug: createSlug("Profit Warning"),
        definition:
          "An ASX disclosure that earnings will materially miss prior guidance. Profit warnings are price-sensitive and frequently trigger sharp gaps lower — short-seller targets.",
        related: ["Guidance", "Continuous Disclosure"],
      },
      {
        term: "Guidance",
        slug: createSlug("Guidance"),
        definition:
          "Company forecasts for revenue, earnings, or other metrics. ASX continuous-disclosure rules require companies to update guidance when actuals will diverge materially.",
        related: ["Profit Warning", "Continuous Disclosure"],
      },
    ],
  },
  {
    category: "Reporting & Disclosure",
    terms: [
      {
        term: "Continuous Disclosure",
        slug: createSlug("Continuous Disclosure"),
        definition:
          "ASX Listing Rule 3.1 requires listed entities to immediately disclose information a reasonable person would expect to materially affect the share price. Underpins the price-sensitive flag on ASX announcements.",
        related: ["Guidance", "Profit Warning"],
      },
      {
        term: "Half-Year Report",
        slug: createSlug("Half-Year Report"),
        definition:
          "Unaudited interim financial accounts ASX 200 companies file with ASIC by 31 August (December-balance) or 28 February (June-balance). Half-year reporting is a peak window for guidance updates and short-position rebalancing.",
        related: ["Full-Year Report", "Continuous Disclosure"],
      },
      {
        term: "Full-Year Report",
        slug: createSlug("Full-Year Report"),
        definition:
          "Audited annual report lodged with ASIC and the ASX. The Annual General Meeting (AGM) typically follows within four months. Heavy short-position adjustments often cluster around full-year results.",
        related: ["Half-Year Report", "Annual General Meeting"],
      },
      {
        term: "Quarterly Activities Report",
        slug: createSlug("Quarterly Activities Report"),
        definition:
          "Required for mining and biotech 'commitments' companies — quarterly cash-flow and operations updates due 30 days after each quarter-end. Often the catalyst for short-seller theses on early-stage explorers.",
        related: ["Full-Year Report"],
      },
      {
        term: "Annual General Meeting",
        slug: createSlug("Annual General Meeting"),
        definition:
          "The yearly shareholder meeting where dividends are ratified, directors elected, and the remuneration report is voted on. AGMs often produce price-sensitive Q&A and trading-update disclosures.",
        related: ["Full-Year Report"],
      },
    ],
  },
  {
    category: "Tax & Legal",
    terms: [
      {
        term: "Capital Gains Tax",
        slug: createSlug("Capital Gains Tax"),
        definition:
          "Australian tax on gains realised when selling investments. For short sellers, gains are taxed as ordinary income (not CGT) because the position is closed by buying rather than selling.",
        related: ["CGT Discount"],
      },
      {
        term: "CGT Discount",
        slug: createSlug("CGT Discount"),
        definition:
          "Australian individuals and trusts holding an asset for >12 months pay CGT on only half their gain. Does not apply to short sellers — short positions are taxed as revenue gains.",
        related: ["Capital Gains Tax"],
      },
      {
        term: "Wash Sale",
        slug: createSlug("Wash Sale"),
        definition:
          "Selling an asset and rebuying a substantially identical asset within a short window solely to crystallise a tax loss. The ATO can disallow the loss under Part IVA general anti-avoidance rules.",
        related: ["Capital Gains Tax"],
      },
      {
        term: "Insider Trading",
        slug: createSlug("Insider Trading"),
        definition:
          "Trading on material non-public information, prohibited under Corporations Act s1043A. ASIC actively prosecutes insider-trading cases. Director trades are publicly disclosed via Appendix 3Y notices.",
        related: ["Director Trade", "Continuous Disclosure"],
      },
      {
        term: "Director Trade",
        slug: createSlug("Director Trade"),
        definition:
          "A purchase or sale of company shares by a director, lodged with the ASX via an Appendix 3Y change-of-interest notice within 14 days. Often watched as a sentiment signal by short sellers.",
        related: ["Insider Trading", "Continuous Disclosure"],
      },
    ],
  },
];

// Flat list of all terms for lookups
export const allTerms: GlossaryTerm[] = glossaryTerms.flatMap((c) => c.terms);

// Lookup term by slug
export function getTermBySlug(slug: string): GlossaryTerm | undefined {
  return allTerms.find((t) => t.slug === slug);
}

// Get category for a term
export function getCategoryForTerm(
  term: string,
): string | undefined {
  for (const cat of glossaryTerms) {
    if (cat.terms.some((t) => t.term === term)) {
      return cat.category;
    }
  }
  return undefined;
}

// Get all slugs for static generation
export function getAllTermSlugs(): string[] {
  return allTerms.map((t) => t.slug);
}

// Find related terms as GlossaryTerm objects
export function getRelatedTerms(term: GlossaryTerm): GlossaryTerm[] {
  return term.related
    .map((name) => allTerms.find((t) => t.term === name))
    .filter((t): t is GlossaryTerm => t !== undefined);
}
