/** An internal pointer from a definition to the live data that shows it. */
export interface GlossaryDataLink {
  label: string;
  href: string;
}

export interface GlossaryTerm {
  term: string;
  slug: string;
  /**
   * Concise, snippet-optimised definition — one or two sentences. This is the
   * only field used for the DefinedTerm schema description, list previews and
   * OG cards, so it must stay short.
   */
  definition: string;
  /**
   * Optional long-form explanation, one string per paragraph. Rendered as page
   * content beneath the definition; deliberately kept out of structured data.
   */
  details?: string[];
  /** Optional "see it in the data" pointers rendered as internal links. */
  dataLinks?: GlossaryDataLink[];
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
        details: [
          "A short sale runs in the opposite order to an ordinary trade. The seller first borrows stock from a holder willing to lend it — typically a superannuation fund, index manager or custodian — and sells those borrowed shares on market at the prevailing price. The proceeds sit as collateral with the lender. To close the trade the seller buys the same number of shares back on market and returns them, keeping the difference between the sale price and the repurchase price, less the borrow fee and any dividends that had to be passed back to the lender.",
          "Australia only permits covered short selling. Section 1020B of the Corporations Act 2001 prohibits selling a listed security you have no presently exercisable right to vest in the buyer, so a securities lending arrangement — confirmed by the broker as a locate — must be in place before the order is entered. Sellers also flag short sales to their broker, who reports them to the ASX, and separately report net short positions to ASIC once they exceed $100,000 or 0.01% of a company's issued capital, whichever is smaller.",
          "ASIC aggregates those reports across every participant and publishes the result with a four trading day delay. That is the dataset behind every number on this site: a net figure, meaning long holdings in the same security are netted off, and an aggregate one, so no individual fund's position is identifiable. The delay matters when reading the data — a position shown today reflects where the market stood four trading days earlier.",
          "The risk profile is asymmetric. A long position can only fall to zero, but a short position loses money for as long as the share price keeps rising, and the loss has no ceiling. Carrying costs accrue daily through the borrow fee, dividends must be manufactured back to the lender, and the lender can recall the stock at any time and force the position closed at an inconvenient price. That combination is why short sellers pay close attention to liquidity and to how crowded a trade has become.",
          "In the ASIC data, short selling shows up as short interest — the reported short position expressed as a percentage of shares on issue. Comparing that figure against a stock's own history, against its sector, and against its average daily volume is the usual way to judge whether a position is unusual or simply routine hedging activity.",
        ],
        dataLinks: [
          { label: "Top 50 most shorted ASX stocks", href: "/top" },
          { label: "Screen ASX stocks by short interest", href: "/screener" },
          { label: "Short interest by industry", href: "/industry" },
        ],
        related: ["Short Position", "Securities Lending", "Short Squeeze"],
      },
      {
        term: "Short Position",
        slug: createSlug("Short Position"),
        definition:
          "The number of shares of a particular stock that have been sold short but not yet covered or closed out. On the ASX, significant short positions must be reported to ASIC.",
        details: [
          "A short position is an open obligation, not a completed trade. Until the borrowed shares are bought back and returned, the seller owes stock to the lender and carries the full exposure to any price move. The position is measured in shares — the count of borrowed shares sold and not yet repurchased — and converted to a percentage of shares on issue to make it comparable across companies of different sizes.",
          "What ASIC publishes is a net figure. Under Regulatory Guide 196 a reporting entity offsets the long holdings it controls in the same security against its short sales, and reports only the residual directional exposure. A desk that is short 5 million shares and long 3 million reports 2 million. This is why the Australian figures are usually lower than gross short sale volume for the same stock, and why a large day of short selling does not necessarily lift the reported position at all.",
          "Reporting is triggered when a participant's net short position exceeds $100,000 or 0.01% of issued capital, whichever is smaller, measured at the end of each trading day. ASIC then aggregates every participant's report into one number per security and publishes it four trading days later. Individual positions are never disclosed, so the data shows how much stock is short but not who holds it.",
          "A position closes in one of three ways. The seller buys the shares back on market and returns them, which is short covering. The lender recalls the stock and the borrower is forced to source replacement shares or close out. Or a corporate action removes the security altogether — a takeover completing, for example, which is why short positions in a target can fall away sharply near a scheme meeting.",
          "Reading a single day's position tells you little on its own. The useful comparisons are the trend in that stock over weeks and months, the position relative to average daily volume, and the position relative to sector peers facing the same conditions.",
        ],
        dataLinks: [
          { label: "Short position history for every ASX stock", href: "/top" },
          { label: "Biggest short position changes", href: "/scans" },
        ],
        related: ["Short Interest", "ASIC"],
      },
      {
        term: "Short Interest",
        slug: createSlug("Short Interest"),
        definition:
          "The percentage of a company's total shares on issue that are currently held as short positions. Expressed as a percentage, e.g., 10% short interest means 10% of all shares are shorted.",
        details: [
          "Short interest is the standard way to compare short selling across companies. Dividing the aggregated net short position by total shares on issue removes the effect of company size, so a mid-cap with 40 million shares short and a large-cap with 400 million short can be ranked on the same scale. Every ranking on this site uses that percentage, calculated from the two fields ASIC publishes side by side: reported short positions and total product in issue.",
          "There is no universal level at which short interest becomes notable. Most ASX-listed securities sit well below 1%. Anything above 5% is uncommon, above 10% is genuinely heavy, and the small group above 20% represents concentrated, high-conviction positioning. Context matters more than the absolute number — lithium, buy-now-pay-later and speculative resources names have historically carried structurally higher short interest than banks or infrastructure trusts, so comparing a stock against its own sector is more informative than comparing it against the market.",
          "Because Australia reports net positions, short interest understates total short selling activity. Hedged and arbitrage strategies — convertible bond arbitrage, index arbitrage, merger arbitrage, market making — all generate short exposure that is partly netted away or is not a directional bet against the company at all. High short interest is evidence of positioning, not proof of a bearish thesis.",
          "The T+4 publication delay means the figure describes the market as it stood four trading days ago. During fast-moving events, a profit warning or a capital raising, the published number can lag the real one materially. The trend across successive reports is usually more reliable than any single day, and a steadily rising line matters more than one large print.",
          "Short interest is also the input to several derived measures. Divided by average daily volume it becomes days to cover, an estimate of how long the exits would take. Measured against free float rather than shares on issue it rises, sometimes considerably, because locked-up and strategic holdings are excluded from the denominator.",
        ],
        dataLinks: [
          { label: "ASX stocks ranked by short interest", href: "/top" },
          { label: "Average short interest by industry", href: "/industry" },
          { label: "Market-wide short interest statistics", href: "/statistics" },
        ],
        related: ["Short Position", "Shares on Issue"],
      },
      {
        term: "Short Squeeze",
        slug: createSlug("Short Squeeze"),
        definition:
          "A rapid increase in a stock's price caused by short sellers rushing to cover their positions. When many shorts try to buy shares simultaneously, it can drive the price up dramatically, forcing more shorts to cover.",
        details: [
          "A squeeze is a feedback loop. Something lifts the share price — an earnings beat, a takeover approach, an upgrade, or simply buying that outpaces available sellers. Short sellers facing mounting losses buy stock to close their positions, and that buying pushes the price higher still, which pressures the next tier of shorts. Because the shorts are buying into the same order book as everyone else, and because their buying is price-insensitive once risk limits are hit, the move can be far larger than the news that started it.",
          "Three conditions make a squeeze more likely. High short interest relative to shares on issue means there is a large pool of forced buyers. High days to cover means that pool cannot exit quickly, because the daily volume simply is not there. And tight borrow supply — high utilisation, elevated borrow fees, hard-to-borrow status — means recalls are likely and replacement stock is expensive, adding a second source of forced closing.",
          "Margin mechanics accelerate the process. As the price rises, the short seller's collateral requirement grows, triggering margin calls. A seller who cannot meet the call has the position closed out by the broker regardless of conviction. Stop-loss orders sitting above the market trigger in sequence, each one a buy order. Where listed options are active, market makers hedging short call exposure buy the underlying as it rises, adding a gamma squeeze on top.",
          "In the Australian data, squeeze setups are visible but not timeable. The ASIC figures arrive with a four trading day delay, so by the time a very high short interest reading is published, the position may already be unwinding. Borrow fee and utilisation data, which would show the supply side tightening, is not publicly disclosed on the ASX at all — it sits with prime brokers and stock lending desks. What the public data does show reliably is where the crowding is, and how long an orderly exit would take.",
          "Squeezes end as abruptly as they begin. Once the forced buying is exhausted the price usually gives back a large part of the move, because nothing about the underlying business has changed. High short interest is a description of positioning, not a prediction.",
        ],
        dataLinks: [
          { label: "Most crowded short positions on the ASX", href: "/top" },
          { label: "Filter by days to cover in the screener", href: "/screener" },
        ],
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
        details: [
          "The delay is a consequence of how the reports are assembled, not an arbitrary embargo. Each reporting entity calculates its net short position as at the close of trading, lodges it with ASIC by the deadline set out in Regulatory Guide 196, and ASIC then aggregates every lodgement for every security before publishing a single figure per stock. The four trading day gap allows for lodgement, aggregation and correction of late or amended reports.",
          "Trading days, not calendar days, drive the schedule. A position dated Monday appears on Friday. A position dated Thursday appears on the following Wednesday. Public holidays push the sequence further out, and the ASX and national holiday calendars mean the gap can stretch to more than a week of wall-clock time around Easter and Christmas.",
          "The practical consequence is that every short interest figure is historical. During a fast-moving event — a downgrade, an equity raising, a takeover bid — the published position describes the market before the news. Positions can be opened and closed entirely inside the window and never appear as a peak in the published series. Anyone using the data to infer what short sellers are doing right now is reading a four-day-old photograph.",
          "This delay also explains why the data works better as a trend than a signal. Consecutive reports showing a position building over weeks are meaningful, because the direction survives the lag. A single elevated print is not, because the position behind it may already have been covered. The same applies in reverse: a sharp fall in reported short interest often reflects covering that finished days before it became visible.",
          "The delay is unrelated to settlement. T+2 settlement is the two business day cycle for delivering shares and cash after a trade; the T+4 short position delay is a disclosure timetable. The two are frequently conflated but govern entirely different obligations.",
          "Note also that this delay applies to reported net positions, not to short sale transactions. Gross short sale volumes reported by brokers to the ASX under the transaction reporting obligation are published on a much shorter cycle. They measure trading flow on a given day rather than open positions, so the two series answer different questions and should not be compared as though one were a faster version of the other.",
        ],
        dataLinks: [
          { label: "Latest published short position data", href: "/top" },
          { label: "How Shorted sources and processes ASIC data", href: "/methodology" },
        ],
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
        details: [
          "RG 196 is ASIC's guidance on how the short selling disclosure regime in the Corporations Act 2001 works in practice. The Act creates the obligations — the prohibition on naked short selling in section 1020B, transaction reporting under section 1020AC, and net short position reporting under section 1020AB — and the guide explains who must report, what must be counted, how it is calculated and by when it must be lodged.",
          "Two distinct disclosures sit under the regime. The first is at the point of sale: a seller must tell its broker the order is a short sale, and the broker reports that to the ASX, producing daily gross short sale transaction data. The second is positional: a person must report their net short position in a security to ASIC when it exceeds $100,000 or 0.01% of issued capital, whichever is smaller, measured as at the close of each trading day.",
          "The netting rule is what makes Australian figures distinctive. Long positions the reporting entity holds in the same security are offset against its short sales, so what is reported is residual directional exposure rather than gross borrowing. Aggregating those reports across all participants produces the single figure ASIC publishes per security, four trading days after the position date. Individual reporters are never identified.",
          "The regime dates from the global financial crisis. Short selling was suspended in Australia in 2008, reinstated in stages, and the current framework of covered-only selling plus mandatory position disclosure was built around that experience. ASIC retains standing powers to intervene in the market, and the modification and relief provisions in the regime accommodate genuine hedging, market making and certain deferred settlement situations.",
          "Everything on this site derives from the dataset RG 196 produces: aggregated, net, delayed by four trading days, and covering only positions above the reporting threshold. Understanding those four properties is what separates reading the data correctly from over-reading it — smaller positions are absent entirely, hedged exposure is netted away, and the picture is always several sessions old.",
        ],
        dataLinks: [
          { label: "How Shorted processes the ASIC data", href: "/methodology" },
          { label: "Published short positions by stock", href: "/top" },
        ],
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
        details: [
          "Securities lending is the plumbing that makes covered short selling possible. Long-term holders with no intention of selling — superannuation funds, index managers, sovereign wealth funds, insurers and the custodians acting for them — make their holdings available to borrowers in exchange for a fee. The borrower posts collateral, usually cash but sometimes government bonds or other high-quality securities, typically worth more than the loaned stock so the lender is protected against a default.",
          "Legal title passes to the borrower for the life of the loan, which is what allows the borrower to sell the shares on market. The lender retains the economic exposure: any dividend paid during the loan is passed back as a manufactured dividend, and the lender continues to bear the price risk as though it still held the stock. Voting rights, however, travel with title, which is why lenders routinely recall stock ahead of contentious annual general meetings.",
          "Most Australian lending runs through agent lenders and prime brokers under a Global Master Securities Lending Agreement, the industry-standard documentation. Loans are usually open-ended rather than term, meaning either side can end them at any time. The lender can recall the shares, forcing the borrower to return stock it has already sold, and the borrower can return them whenever the short is closed.",
          "The supply side sets the price of shorting. Where a stock is widely held by lenders and lightly borrowed, fees are trivial and the stock is easy-to-borrow. Where lendable supply is thin — a small free float, a concentrated register, holders who decline to lend — fees rise, the stock becomes hard-to-borrow, and utilisation climbs toward the point where recalls become likely.",
          "Australian lending data is not public. Utilisation, borrow fees and loan balances are commercial information held by prime brokers and specialist data vendors, unlike the net short positions ASIC publishes. Short interest is therefore the visible half of the picture: it shows how much stock has been borrowed and sold, but not how expensive or precarious those borrows have become.",
        ],
        dataLinks: [
          { label: "Stocks with the largest borrowed and sold positions", href: "/top" },
        ],
        related: ["Short Selling", "Borrowing Cost"],
      },
      {
        term: "Short Covering",
        slug: createSlug("Short Covering"),
        definition:
          "The process of closing out a short position by buying back the shares that were previously sold short. Also called 'covering' or 'closing a short'.",
        details: [
          "Covering completes the short trade. The seller buys the required number of shares on market, returns them to the lender, recovers the collateral and settles the borrow fee. Only at that point is the profit or loss realised, and only at that point does the exposure to further price rises end. Until then the position remains open no matter how far the price has moved.",
          "Covering is buying pressure, and that is what makes it consequential. Every short position is a future buy order in the market. Where positions are large relative to daily turnover, the exit itself moves the price against the sellers doing the exiting, which is the mechanism behind a short squeeze. Days to cover exists precisely to estimate how much of that latent demand is stacked up.",
          "Not all covering is voluntary. A lender recall forces the borrower to return shares, and if replacement stock cannot be sourced the position must be closed. A margin call that cannot be met is closed out by the broker. Rising borrow fees can make a position uneconomic to hold even when the thesis is intact. These forced exits cluster around the same events — dividend record dates, index rebalances, meeting dates — because that is when lenders want their stock back.",
          "Voluntary covering is usually about the thesis playing out. A profit warning arrives and the price gaps down, a takeover is announced and the downside disappears, or the valuation gap the seller was betting on closes. Sellers also cover into capitulation and panic selling, when volume is heavy enough to absorb a large buy order without moving the price much.",
          "In the ASIC data, covering appears as a falling reported short position across successive publications. Because of the four trading day delay, the decline is visible only after the fact — often after the price has already responded to the buying. A steep multi-day fall in short interest alongside a rising share price is the signature of a position being unwound in size.",
        ],
        dataLinks: [
          { label: "Largest reductions in short positions", href: "/scans" },
          { label: "Track short position trends by stock", href: "/top" },
        ],
        related: ["Short Squeeze", "Short Position"],
      },
      {
        term: "Days to Cover",
        slug: createSlug("Days to Cover"),
        definition:
          "The number of days it would take for all short sellers to cover their positions based on average daily trading volume. Calculated as: Short Interest ÷ Average Daily Volume.",
        details: [
          "Days to cover converts a short position into a measure of how hard it would be to exit. Divide the reported short position, in shares, by the stock's average daily volume, usually over a 20 or 30 day window. A stock with 20 million shares short and 4 million shares traded a day has five days to cover: if short sellers were the only buyers, and volume held at its average, closing every position would take a full trading week.",
          "The number is a liquidity ratio, not a forecast. It assumes short sellers account for all trading, which they never do, and that volume stays at its recent average, which it does not — volume typically spikes on exactly the days shorts are trying to exit. Treat it as a relative gauge: a stock at eight days to cover is a far more congested exit than one at half a day, whatever the absolute figures imply.",
          "This is why it is a better crowding signal than short interest alone. A 4% short position in a heavily traded large-cap can be unwound in an afternoon. The same 4% in an illiquid small-cap may represent weeks of turnover, and it is that second case where a rally forces buying into a market with no sellers. High days to cover combined with high short interest is the classic squeeze setup.",
          "Both inputs come with caveats on the ASX. The short position is the aggregated net figure ASIC publishes with a four trading day delay, so the numerator is stale by construction. Average daily volume can be distorted by index rebalance days, block crossings and takeover activity, any of which inflate the denominator and make the exit look easier than it is. Short-dated averages react quickly to those events; longer windows smooth them out.",
          "Days to cover is also published under the name short interest ratio, particularly in US-sourced research. The two terms describe the same calculation, and both are used interchangeably in ASX commentary.",
        ],
        dataLinks: [
          { label: "Screen ASX stocks by days to cover", href: "/screener" },
          { label: "Most crowded short positions", href: "/top" },
        ],
        related: ["Short Interest", "Short Squeeze"],
      },
      {
        term: "Borrowing Cost",
        slug: createSlug("Borrowing Cost"),
        definition:
          "The interest rate charged to borrow shares for short selling. Hard-to-borrow stocks have higher borrowing costs, which can exceed 50% annually for heavily shorted stocks.",
        details: [
          "Borrowing cost is the all-in carry of holding a short position, and it accrues every day the position stays open. The largest component is the borrow fee charged by the lender, quoted as an annualised percentage of the position's market value and accrued daily. On top of that sit the manufactured dividends owed to the lender, the opportunity cost of collateral posted against the loan, and financing charges levied by the prime broker.",
          "The fee is set by supply and demand for the specific stock, not by any central rate. Widely held large-caps with deep lendable supply cost very little to borrow. Scarcity changes that quickly: as utilisation of the lendable pool rises, lenders price the remaining supply higher, and a name that was cheap to short can become expensive within days of a thesis becoming crowded.",
          "Carry is what turns a slow-burning short into a losing one. A position costing a substantial annualised rate to hold needs the share price to fall by at least that much simply to break even, before any consideration of dividends. This is why short sellers care about catalysts and timing in a way long investors often do not — a long position can wait indefinitely, a short position is paying rent.",
          "Australian dividends make the carry heavier than the headline fee suggests. Every dividend paid during the loan must be manufactured back to the lender, and with the high payout ratios typical of ASX industrials and banks, a short held across two dividend dates can accrue a material cost from distributions alone. Franking adds a further wrinkle in negotiating what the lender is made whole for.",
          "None of this is publicly disclosed on the ASX. Borrow fees, utilisation and loan balances are commercial data held by prime brokers and lending desks. The ASIC data shows the size of a short position but not what it costs to maintain, so a position that looks stable in the published series may be under real economic pressure that the numbers cannot show.",
        ],
        dataLinks: [
          { label: "Long-running short positions by stock", href: "/top" },
        ],
        related: ["Securities Lending", "Short Selling"],
      },
      {
        term: "Margin Call",
        slug: createSlug("Margin Call"),
        definition:
          "A demand from a broker for additional funds when a short position moves against the trader. If the stock price rises significantly, the short seller must deposit more collateral.",
        details: [
          "Short positions are marked to market continuously. The borrowed shares are revalued each day, and if the price has risen the seller's obligation has grown, so the collateral supporting it must grow too. When the account falls below the maintenance margin the broker issues a call: deposit funds, or have the position reduced or closed at the broker's discretion.",
          "The asymmetry of shorting makes calls a structural feature rather than an edge case. A long position that halves ties up capital but generates no new demand for funds. A short position that doubles has lost 100% of the notional and requires fresh collateral to keep alive, and there is no upper bound on how much more the price can rise. A seller can be entirely right about a company and still be closed out before the thesis plays out.",
          "Calls tend to arrive at the worst moment for the market as a whole. The same price spike hits every seller in the name simultaneously, so multiple accounts are forced to buy at once. Positions closed out by brokers are closed without regard to price, which is why margin-driven liquidation is a core accelerant of a short squeeze alongside stop-loss orders and option dealer hedging.",
          "In Australia, the terms are set by the prime broker or margin lender rather than by regulation, and they can be changed. Brokers routinely raise margin requirements on volatile or hard-to-borrow stocks, and an increase applies to positions already open. A seller can face a call without the share price having moved at all, simply because the broker has repriced the risk.",
          "The published short position data shows the aftermath, not the cause. A sharp drop in reported short interest after a price spike is consistent with forced covering, but the ASIC series carries a four trading day delay and does not distinguish a voluntary exit from a liquidated one.",
          "Managing the risk is a sizing problem rather than a forecasting one. Sellers who keep positions small relative to capital, hold surplus collateral against them, and set exit levels in advance retain the choice of when to close. Sellers who are fully committed hand that choice to the broker, which is why disciplined short books cap individual positions well below the level a comparable long position would take.",
        ],
        dataLinks: [
          { label: "Stocks with sharp short position reversals", href: "/scans" },
        ],
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
        details: [
          "Shares on issue is the complete count of a company's ordinary shares in existence, held by everyone: institutions, retail investors, directors, founders, strategic holders and escrowed parties alike. It is the figure companies report to the ASX in their Appendix 2A and 3B notices, and it changes whenever new equity is created or cancelled.",
          "It matters here because it is the denominator in every short interest percentage on this site. ASIC publishes two numbers side by side for each security — reported short positions and total product in issue — and dividing one by the other produces the percentage used to rank stocks. Using the same denominator across the market is what makes a mid-cap and a large-cap comparable.",
          "Corporate actions move the number, sometimes substantially. Placements, rights issues, share purchase plans and the conversion of options or performance rights all increase shares on issue; buybacks reduce it. Because the short position percentage is a ratio, a large capital raising can lower reported short interest even when the number of shares sold short has not changed at all. Reading a sudden drop as short covering, when the register simply grew, is a common error.",
          "Shares on issue is broader than free float. Float excludes shares that are not genuinely available to trade — founder stakes, escrowed shares from a recent listing, strategic corporate holdings, cornerstone investors. Short interest measured against free float is always higher, sometimes far higher, than the same position measured against shares on issue, which is why the two must never be compared directly.",
          "The figure is also not the same as market capitalisation, though it is an input to it. Market cap multiplies shares on issue by the share price; shares on issue is a pure count and moves only on corporate actions, not on price.",
          "A few structures complicate the count. Companies with more than one class of equity, stapled securities such as listed property and infrastructure trusts, and foreign entities quoted through CHESS Depositary Interests all report against the specific quoted line rather than a single consolidated share count. Because ASIC's short position data is keyed to the quoted product, the percentage always refers to that product's own shares on issue.",
        ],
        dataLinks: [
          { label: "Short positions as a share of stock on issue", href: "/top" },
        ],
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
        term: "Covered Short Selling",
        slug: createSlug("Covered Short Selling"),
        definition:
          "A short sale where the seller has already borrowed the shares, or secured a binding right to them, before the sale is executed. Covered short selling is the only form of short selling permitted on the ASX.",
        related: ["Naked Short Selling", "Locate", "Securities Lending"],
        details: [
          "Covered means the delivery obligation is already solved at the moment of sale. Before the order goes to market the seller has a securities lending arrangement in place, or another presently exercisable and unconditional right to vest the products in the buyer. The broker confirms this as a locate. When settlement falls due the borrowed shares are delivered, and the buyer is never exposed to the possibility that the seller simply cannot produce stock.",
          "Australian law makes this the only lawful route. Section 1020B of the Corporations Act 2001 prohibits selling section 1020B products — shares, debentures and similar financial products traded on a licensed market — without that right to vest. ASIC Regulatory Guide 196 sets out how the prohibition and the accompanying disclosure obligations operate in practice. The framework was tightened after the 2008 global financial crisis, when short selling was briefly banned outright and then reintroduced under the current covered-only regime.",
          "Two separate disclosures follow a covered short sale. The seller must inform its broker that the order is a short sale, and the broker reports that to the ASX as short sale transaction information under section 1020AC, producing the daily gross short sale volume figures. Separately, under section 1020AB, the seller reports its net short position to ASIC once the position exceeds $100,000 or 0.01% of issued capital. The second of those is the dataset behind the short interest percentages on this site.",
          "Because the stock must be borrowed first, every covered short carries the economics of the loan. A borrow fee accrues daily, dividends paid during the loan must be manufactured back to the lender, and the lender retains the right to recall the shares. Those costs are what make crowded shorts in illiquid, hard-to-borrow names expensive to hold, quite apart from the price risk.",
          "The distinction also explains a quirk of the published data. Because positions must be covered, the reported short interest is bounded by the stock actually available to borrow. Figures well above the lendable float would suggest a data or classification problem rather than aggressive positioning.",
        ],
        dataLinks: [
          { label: "Reported short positions across the ASX", href: "/top" },
          { label: "How the ASIC short position data is compiled", href: "/methodology" },
        ],
      },
      {
        term: "Naked Short Selling",
        slug: createSlug("Naked Short Selling"),
        definition:
          "Selling shares short without first borrowing them or securing a right to deliver them. Naked short selling of listed securities is prohibited in Australia under section 1020B of the Corporations Act 2001.",
        related: ["Covered Short Selling", "Locate", "Fail to Deliver"],
        details: [
          "In a naked short sale the seller enters a sell order for stock it neither owns nor has arranged to borrow, intending to source the shares later — or to buy them back intraday and never deliver at all. The trade creates a delivery obligation with nothing behind it. If the seller cannot obtain shares before settlement, the trade fails.",
          "Australia prohibits the practice for listed securities. Section 1020B of the Corporations Act 2001 requires a seller to have a presently exercisable and unconditional right to vest the products in the buyer at the time of sale, which in practice means a securities lending arrangement confirmed as a locate. ASIC Regulatory Guide 196 sets out the guidance around the prohibition and the related disclosure regime. Limited exceptions exist, principally for market makers meeting defined obligations, and these are narrowly drawn.",
          "The concern is not that naked shorting is bearish. It is that an uncovered sale creates a claim to shares that may not exist, which can depress a price beyond what the available supply would support and leaves the buyer exposed to settlement failure. Repeated or systemic fails also erode confidence in the settlement system itself.",
          "Persistent fails to deliver are the usual footprint. The ASX operates a settlement discipline regime with close-out requirements and fail fees, and publishes settlement fail statistics; ASIC investigates suspected breaches and has pursued enforcement action for uncovered short selling. Because a fail can also arise from ordinary administrative error or a recall going wrong, a single fail is not itself evidence of naked shorting.",
          "None of this appears in the short position data. What ASIC publishes is the aggregated net short position of participants who have complied with their reporting obligations, all of which relate to covered positions. Claims that a heavily shorted stock is being naked-shorted cannot be tested with the public dataset, which is one reason the numbers on this site should be read as disclosed positioning rather than as a complete account of every trade.",
        ],
        dataLinks: [
          { label: "Reported short positions across the ASX", href: "/top" },
        ],
      },
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
        details: [
          "Most stock loans are open-ended rather than fixed term, so the lender can ask for its shares back at any time. When a recall is issued the borrower has a short window — typically aligned to the settlement cycle — to return the stock. It can do that by borrowing the same shares from another lender, or by buying them on market and closing the short. If neither is possible the loan is bought in on the borrower's account, at whatever price the market offers.",
          "Recalls cluster around predictable dates. Lenders want their stock back ahead of dividend record dates so they receive the dividend and its franking credits directly rather than a manufactured payment, ahead of annual general meetings and scheme meetings so they can vote, and ahead of rights issues and other corporate actions where entitlements attach to the registered holder. They also recall when they simply decide to sell the underlying holding.",
          "The franking system gives Australian recalls a particular edge. A manufactured dividend compensates the lender for the cash, but the franking credit attached to an ASX dividend cannot be passed through in the same way, and the tax treatment differs. Lenders who value franking — Australian superannuation funds especially — have a strong incentive to hold the stock across the record date themselves, which concentrates recall activity into the February and August dividend seasons.",
          "For the short seller, a recall is the risk that the position ends on someone else's timetable. It is most dangerous exactly where it is most likely: in stocks with a small lendable pool and high utilisation, where replacement borrow does not exist and the buy-in becomes real purchasing into a thin market. A cascade of recalls in a crowded name produces forced covering indistinguishable from a squeeze.",
          "Recalls are invisible in the public data. The ASIC series shows the reported short position falling four trading days later, with no indication of whether the seller chose to exit or was made to. A sharp fall in short interest around a dividend record date is often a recall footprint rather than a change of conviction.",
        ],
        dataLinks: [
          { label: "Short position changes around dividend season", href: "/scans" },
        ],
        related: ["Securities Lending", "Short Squeeze", "Short Covering"],
      },
      {
        term: "Rebate Rate",
        slug: createSlug("Rebate Rate"),
        definition:
          "The interest a short seller earns on cash collateral posted to borrow shares, less the borrow fee charged by the lender. For hard-to-borrow stocks the rebate can be negative — the short seller pays to hold the position.",
        details: [
          "In a cash-collateralised stock loan the borrower posts cash with the lender, usually a little more than the market value of the shares. That cash earns interest, and the lender passes part of it back to the borrower as the rebate. The rebate is therefore the short-term interest rate less whatever the lender keeps as its fee for supplying the stock.",
          "The arithmetic decides who pays whom. Where the stock is easy to borrow the lender's fee is small, so most of the interest flows back and the short seller earns a positive rebate — the position generates income while it is held. Where the stock is scarce the fee exceeds the interest available, the rebate turns negative, and the short seller pays the difference. A negative rebate is the same economic fact as a high borrow fee, expressed from the other side of the trade.",
          "Because the interest component tracks short-term rates, monetary policy changes the carry of every short position in the market. When the RBA cash rate is high, collateral earns more and shorting is cheaper to fund; when it is near zero, the rebate is thin and the borrow fee dominates. Sellers running large books notice this as a portfolio-wide cost, not a stock-specific one.",
          "Not every loan is cash-collateralised. Where the borrower posts government bonds or other securities instead, no rebate arises and the lender simply charges an explicit borrow fee. Australian institutional lending uses both structures, documented under a Global Master Securities Lending Agreement, with the choice depending on the counterparties and the collateral each prefers to hold.",
          "Rebate rates are bilateral and confidential. They are negotiated between the borrower, its prime broker and the agent lender, and are not disclosed in any public ASX or ASIC dataset. The published short position figures show what has been borrowed and sold, but reveal nothing about the rate at which it is being financed.",
        ],
        dataLinks: [
          { label: "Reported short positions across the ASX", href: "/top" },
        ],
        related: ["Borrow Fee", "Hard-to-Borrow", "Securities Lending"],
      },
      {
        term: "Borrow Fee",
        slug: createSlug("Borrow Fee"),
        definition:
          "The annualised cost of borrowing shares to maintain a short position, expressed as a percentage of the position's market value. Highly-shorted or low-float ASX stocks can carry borrow fees of 20-50% or more.",
        details: [
          "The borrow fee is what the lender charges for making its shares available. It is quoted as an annual percentage of the loan's market value and accrues daily, so it is recalculated as the share price moves — a short that goes against the seller costs more to carry as well as showing a loss. The fee is paid whether the thesis works or not, and it stops only when the shares are returned.",
          "Pricing is set stock by stock in a negotiated market, not by any published rate. The determinants are lendable supply and borrower demand: how much stock the institutions on the register are willing to lend, and how much of it has already been taken. General collateral names — large, widely held, lightly shorted — cost very little. As utilisation of the lendable pool rises, the remaining supply is priced progressively higher.",
          "Fees move fast, and they can be repriced on an existing loan. A stock that was cheap to short when a position was opened can become expensive within days if a thesis becomes crowded or a large lender withdraws. That variability is a real risk for sellers holding a position for months, because the carry assumed at entry may bear no relation to the carry actually paid.",
          "On the ASX the fee is only part of the cost. Dividends paid during the loan must be manufactured back to the lender, and Australian payout ratios are high by global standards, so a position held through the February or August reporting seasons accrues a substantial extra cost. Together the fee and the manufactured dividends form the total borrowing cost of the position.",
          "Australian borrow fees are not public. They sit with prime brokers, agent lenders and commercial data providers, unlike the aggregated net short positions ASIC publishes with a four trading day delay. From the public data, the observable proxies for an expensive borrow are heavy short interest against shares on issue, a small free float and thin trading volume.",
        ],
        dataLinks: [
          { label: "Most heavily shorted ASX stocks", href: "/top" },
          { label: "Screen by short interest and liquidity", href: "/screener" },
        ],
        related: ["Rebate Rate", "Hard-to-Borrow", "Utilisation"],
      },
      {
        term: "Hard-to-Borrow",
        slug: createSlug("Hard-to-Borrow"),
        definition:
          "Stocks where shares for short-selling are scarce, driving up borrow fees and increasing recall risk. Often coincides with a building short squeeze setup. On the ASX, hard-to-borrow status is broker-defined and not publicly listed.",
        details: [
          "Hard-to-borrow describes the supply side of a short, not the merits of the trade. A stock earns the label when the pool of lendable shares is close to exhausted, so a new borrow either cannot be arranged at all or can only be arranged at a punitive fee. Brokers maintain their own hard-to-borrow lists and update them as availability changes; there is no official ASX or ASIC designation.",
          "Scarcity usually has a structural cause. A small free float leaves little stock in circulation to begin with. A concentrated register — a founder, a parent company, a cornerstone investor — removes more. Holders who do not participate in securities lending programmes, including most retail holders, shrink the pool further. Add crowded short interest on top and the remaining supply disappears quickly.",
          "Being hard to borrow changes the trade in three ways. The carry becomes expensive, so the thesis must play out faster to be worth holding. Recall risk rises, because there is no alternative lender to switch to if the current one pulls its stock. And establishing or adding to a position may be impossible regardless of conviction, which caps how crowded the short can become and concentrates the risk in whoever is already in.",
          "This is the supply-side half of a squeeze setup. High short interest tells you how many forced buyers exist and days to cover tells you how long their exit would take; hard-to-borrow status tells you that some of them may be forced out on the lender's schedule rather than their own. The three together are the conditions under which an ordinary rally becomes a violent one.",
          "None of it is visible in the public Australian data. ASIC publishes aggregated net short positions with a four trading day delay and nothing about lending availability. Working from public sources, the closest signal is a large short position in a stock with a tightly held register and modest average daily volume.",
        ],
        dataLinks: [
          { label: "Screen for low-float, heavily shorted stocks", href: "/screener" },
          { label: "Most heavily shorted ASX stocks", href: "/top" },
        ],
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
        details: [
          "Utilisation measures how much of the available borrow has already been taken. The numerator is shares currently on loan; the denominator is the lendable pool — the shares held by institutions participating in securities lending programmes and made available to borrow. It is a supply gauge, and it behaves very differently from short interest, which measures positions rather than availability.",
          "The two can diverge sharply. A stock with modest short interest can run high utilisation if only a small fraction of its register lends, which is common where founders, a parent company or retail holders dominate the share list. Conversely a widely held large-cap can carry a large short position at low utilisation because the lendable pool is enormous. Utilisation is the better read on how close a stock is to running out of borrow.",
          "As it climbs, the economics change. Lenders price the remaining supply higher, so borrow fees rise and the stock drifts toward hard-to-borrow status. Above roughly 90% there is almost no headroom: new shorts cannot be established, existing borrows cannot easily be replaced, and any recall forces a genuine buy-in rather than a switch to another lender. That is the supply-side setup behind most squeezes.",
          "Recall risk rises with it. Lenders pull stock back for dividend record dates, annual general meeting votes and corporate actions, and when utilisation is already high the borrower has nowhere to go. The forced covering that follows is not a change of view — it is a supply failure.",
          "Australian utilisation data is not public. Loan balances and lendable supply sit with prime brokers, agent lenders and commercial data vendors, unlike the net short positions ASIC publishes with a four trading day delay. Working from the public data alone, the closest available proxies are a high short position relative to shares on issue combined with a small free float and thin average daily volume.",
          "One further caveat: the lendable pool is not fixed. It expands when a new institution joins a lending programme or an index fund grows its holding, and it contracts when a lender sells, withdraws or recalls stock to vote. Utilisation can therefore jump without a single new short being opened, simply because supply has shrunk beneath the positions already in place.",
        ],
        dataLinks: [
          { label: "Most heavily shorted ASX stocks", href: "/top" },
          { label: "Screen for low-float, heavily shorted names", href: "/screener" },
        ],
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
        details: [
          "Average daily volume answers a simple question: how much of this stock changes hands in a normal session. It is calculated as total shares traded over a lookback window divided by the number of trading days in it. Windows of 20, 30 and 90 days are all in common use, and the choice matters — a short window tracks current conditions closely but reacts violently to one unusual day, while a long window is stable but slow to register a genuine change in liquidity.",
          "For short selling it is the denominator that turns a position into a time estimate. Days to cover divides the reported short position by average daily volume, producing the number of sessions of ordinary trading it would take to buy every short position back. A large position in a liquid stock is unremarkable; the same position in a thinly traded one is a congested exit.",
          "Several ASX-specific effects distort it. Index rebalance days concentrate enormous volume into a single closing auction, block crossings and off-market special crossings can print a year's worth of turnover at once, and takeover activity lifts volume for weeks. Any of these inflate the average and make a crowded position look easier to unwind than it is. Volume also collapses in the weeks around Christmas and Easter, cutting the other way.",
          "Volume is not the same as liquidity. A stock can trade a reasonable number of shares while showing a wide bid-ask spread and thin depth, meaning a meaningful order still moves the price. Volume measures how much traded, not what it cost to trade it, so ADV is best read alongside spread and market depth rather than on its own.",
          "Because the ASX and Cboe Australia both operate lit order books for ASX-listed securities, and a share of turnover executes off-market, quoted volume figures vary by source depending on which venues are consolidated.",
          "Share volume and dollar volume are also different measures. A stock trading many millions of shares at a few cents represents far less capital than one trading a fraction of that at twenty dollars, so dollar turnover is the better guide to how much money can move without disturbing the price. Days to cover, though, is a share-count calculation, so share volume is the correct input there.",
        ],
        dataLinks: [
          { label: "Filter by liquidity and volume in the screener", href: "/screener" },
        ],
        related: ["Days to Cover", "Liquidity"],
      },
      {
        term: "Free Float",
        slug: createSlug("Free Float"),
        definition:
          "The portion of a company's shares available for public trading, excluding insider, strategic, and locked-up holdings. Low free float amplifies short-squeeze potential because shares are harder to source for borrowing.",
        details: [
          "Free float strips out the shares that are not realistically available to trade. Founder and director holdings, escrowed stock from a recent listing or acquisition, cornerstone and strategic corporate stakes, and holdings a parent company has no intention of selling are all excluded. What remains is the pool that actually changes hands and, importantly, the pool from which shares can be borrowed.",
          "The distinction has a direct effect on short selling. A stock with 60% of its register locked up has only 40% of its shares in circulation, so a short position equal to 5% of shares on issue is really 12.5% of the tradeable stock. Every squeeze mechanic — borrow scarcity, price impact on covering, days to cover — scales against the float, not against the total register.",
          "Float also drives lendable supply, which is narrower again. Only holders who participate in securities lending programmes contribute, so retail holdings held outside lending arrangements and institutions that decline to lend fall out of the pool. Utilisation is measured against that lendable subset, which is why a stock with a modest short position can still be hard-to-borrow if few of its holders lend.",
          "In Australia, index construction uses float-adjusted market capitalisation. S&P applies investable weight factors when compiling the S&P/ASX indices, so a company with a large controlling shareholder receives a smaller index weight than its full market cap implies. That affects passive demand and makes index rebalance dates significant events for low-float names.",
          "The short interest percentages published by ASIC and shown on this site are calculated against total shares on issue, not float, because shares on issue is the figure in the official data. Where a stock has a tightly held register, the effective short interest against tradeable stock is higher than the published number.",
          "A tight float is usually visible from the disclosure record rather than any single published statistic. The top twenty holders listed in the annual report, substantial holding notices lodged under section 671B, escrow terms disclosed in a prospectus, and a recent listing or demerger all point to stock that is unlikely to trade. Persistently low turnover relative to market capitalisation points the same way.",
        ],
        dataLinks: [
          { label: "Screen small and mid-cap ASX stocks", href: "/screener" },
        ],
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
        details: [
          "Franking exists to stop company profits being taxed twice. When an Australian company pays tax on its earnings and then distributes those earnings as a dividend, it can attach franking credits representing the tax already paid. The shareholder declares the grossed-up dividend as income and offsets the credit against their own tax bill. A fully franked dividend carries credits covering the full company tax rate; a partially franked one carries less.",
          "The system shapes who owns Australian shares. Resident individuals and superannuation funds can use franking credits in full, and where the credit exceeds their tax liability the excess is refundable — a feature unusual internationally. That makes fully franked, high-yielding stocks structurally attractive to domestic income investors and to super funds in pension phase, and it explains the concentration of the local market in the banks, large miners and mature industrials that reliably pay franked dividends.",
          "For short sellers the credit is a complication that has no equivalent offshore. Dividends paid during a stock loan are compensated with a cash manufactured dividend, but the franking credit attaches to whoever is the registered holder on the record date — the buyer of the borrowed shares — and cannot simply be handed back to the lender. A lender able to use franking is therefore not made whole by cash alone.",
          "That gap has consequences in the lending market. Lenders price the shortfall into the borrow, or more often decline to lend across the record date and recall their stock instead. The effect is concentrated in the February and August dividend seasons, and it is one reason short positions in high-yield ASX names often ease into record dates and rebuild afterwards. The ATO's rules on securities lending arrangements, together with anti-avoidance provisions targeting the transfer of franking benefits, limit how far these arrangements can be engineered.",
          "Franking also affects how price moves are read. A stock typically falls by roughly the dividend amount on its ex-dividend date, and for a heavily franked payment the grossed-up value to a domestic holder is larger than the cash. Interpreting the ex-date drop as a fundamental decline, in a short thesis or anywhere else, is a mistake.",
        ],
        dataLinks: [
          { label: "Short interest in high-yield ASX sectors", href: "/industry" },
          { label: "Most shorted ASX stocks", href: "/top" },
        ],
        related: ["Manufactured Dividend", "Dividend"],
      },
      {
        term: "Manufactured Dividend",
        slug: createSlug("Manufactured Dividend"),
        definition:
          "A cash payment a short seller makes to the share lender to compensate for dividends paid during the loan period. ATO rules govern the tax treatment, and the obligation often spikes around the ex-dividend date.",
        details: [
          "When shares are lent, legal title passes to the borrower, who sells them to a third party. That third party is the registered holder on the record date and receives the dividend. The lender, who still carries the economic exposure and expected the income, is made whole by the borrower under the loan agreement. That compensating payment is the manufactured dividend, sometimes called a substitute or in-lieu payment.",
          "The obligation is unavoidable for any short held across a record date, and it is a real cost rather than an accounting entry. Australian companies pay out a high proportion of earnings by global standards, and the large industrials, banks and miners that attract the heaviest short interest are also among the biggest payers. A position held through both the interim and final dividends accrues the full year's distribution as a cost on top of the borrow fee.",
          "Franking is where the Australian version gets complicated. An ASX dividend usually carries franking credits representing tax the company has already paid, and those credits attach to the registered holder — the buyer of the shares — not to the lender. A cash manufactured payment replaces the dividend but not the credit, so lenders who can use franking, Australian superannuation funds in particular, are left worse off. That gap is negotiated into the loan pricing, and it is why lenders so often recall stock ahead of record dates rather than lend across them.",
          "Tax treatment follows ATO rules on securities lending arrangements, which set out how manufactured payments are characterised for both parties and when franking benefits can and cannot flow through. Anti-avoidance provisions target arrangements designed mainly to transfer franking benefits, so structuring around the credit is not a free option. This is specialist territory and the treatment depends on the taxpayer.",
          "The practical result is a seasonal rhythm in the data. Australian dividend record dates cluster around February and August, and short positions in high-yield names frequently ease into those dates as sellers avoid the payment or lose their borrow to a recall, then rebuild afterwards.",
        ],
        dataLinks: [
          { label: "Short position changes through dividend season", href: "/scans" },
          { label: "Short interest in high-yield sectors", href: "/industry" },
        ],
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

// Get all slugs for static generation.
// De-duplicated: "Short Interest Ratio" is listed under two categories and
// resolves to one URL, so emitting it twice produced a duplicate static param
// and a duplicate sitemap entry.
export function getAllTermSlugs(): string[] {
  return [...new Set(allTerms.map((t) => t.slug))];
}

// Find related terms as GlossaryTerm objects
export function getRelatedTerms(term: GlossaryTerm): GlossaryTerm[] {
  return term.related
    .map((name) => allTerms.find((t) => t.term === name))
    .filter((t): t is GlossaryTerm => t !== undefined);
}
