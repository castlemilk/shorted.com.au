import { type Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Clock,
  ChevronRight,
  ChevronLeft,
  BookOpen,
  GraduationCap,
} from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Badge } from "~/@/components/ui/badge";
import { Button } from "~/@/components/ui/button";
import {
  BreadcrumbListSchema,
  FAQStructuredData,
} from "~/@/components/seo/enhanced-structured-data";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";

interface PageProps {
  params: Promise<{ slug: string }>;
}

// Article data - in a real app this would come from MDX files or a CMS
const articlesData: Record<
  string,
  {
    title: string;
    description: string;
    readTime: string;
    level: string;
    topics: string[];
    content: React.ReactNode;
    faqs: Array<{ question: string; answer: string }>;
    relatedArticles: string[];
  }
> = {
  "what-is-short-selling": {
    title: "What is Short Selling on the ASX?",
    description:
      "A beginner's guide to short selling on the Australian Securities Exchange. Understand how short selling works, why investors do it, and the risks involved.",
    readTime: "8 min read",
    level: "Beginner",
    topics: ["Short Selling", "ASX Basics", "Investment Strategy"],
    relatedArticles: ["understanding-t4-delay", "how-to-read-short-interest"],
    faqs: [
      {
        question: "What is short selling on the ASX?",
        answer:
          "Short selling on the ASX is a trading strategy where investors borrow shares from another party, sell them immediately, and hope to buy them back later at a lower price. The difference between the sale price and buyback price is the profit (or loss).",
      },
      {
        question: "Is short selling legal in Australia?",
        answer:
          "Yes, short selling is legal in Australia and is regulated by ASIC. However, naked short selling (selling shares without borrowing them first) is illegal.",
      },
      {
        question: "How do I find out which ASX stocks are heavily shorted?",
        answer:
          "ASIC publishes daily short position reports that show the aggregated short positions for ASX-listed stocks. Shorted.com.au provides this data in an easy-to-read format with historical trends.",
      },
    ],
    content: (
      <article className="prose prose-slate dark:prose-invert max-w-none">
        <h2>Introduction to Short Selling</h2>
        <p>
          Short selling is a trading strategy that allows investors to profit from falling stock
          prices. While most investors follow the traditional &quot;buy low, sell high&quot; approach,
          short sellers do the opposite - they sell first and buy later, hoping the price will
          fall in the meantime.
        </p>

        <h2>How Short Selling Works</h2>
        <p>The process of short selling involves several steps:</p>
        <ol>
          <li>
            <strong>Borrowing shares:</strong> The short seller borrows shares from a broker or
            institutional investor who owns the stock.
          </li>
          <li>
            <strong>Selling the borrowed shares:</strong> These borrowed shares are immediately
            sold on the market at the current price.
          </li>
          <li>
            <strong>Waiting for price movement:</strong> The short seller waits, hoping the
            stock price will fall.
          </li>
          <li>
            <strong>Buying back shares:</strong> Eventually, the short seller must buy back the
            same number of shares to return to the lender.
          </li>
          <li>
            <strong>Returning shares and collecting profit/loss:</strong> The difference
            between the selling price and buying price determines the profit or loss.
          </li>
        </ol>

        <h3>Example</h3>
        <p>
          Imagine a short seller believes Company XYZ, currently trading at $50, is overvalued.
          They borrow 100 shares and sell them for $5,000 total. If the stock falls to $40,
          they can buy back 100 shares for $4,000, return them to the lender, and pocket the
          $1,000 difference (minus fees and interest).
        </p>

        <h2>Why Investors Short Sell</h2>
        <p>There are several reasons investors engage in short selling:</p>
        <ul>
          <li>
            <strong>Profit from overvaluation:</strong> When investors believe a stock is
            overpriced, they can profit by betting against it.
          </li>
          <li>
            <strong>Hedge existing positions:</strong> Investors may short sell to protect
            against potential losses in their long positions.
          </li>
          <li>
            <strong>Market efficiency:</strong> Short sellers help identify overvalued companies,
            contributing to more accurate stock prices.
          </li>
        </ul>

        <h2>Risks of Short Selling</h2>
        <p>
          Short selling is considered a high-risk strategy. Unlike buying shares where the
          maximum loss is limited to your investment, short selling has theoretically unlimited
          loss potential because stock prices can rise indefinitely.
        </p>
        <ul>
          <li>
            <strong>Unlimited loss potential:</strong> If the stock price rises instead of
            falls, losses can exceed the original investment.
          </li>
          <li>
            <strong>Short squeeze risk:</strong> If many short sellers try to cover their
            positions simultaneously, it can drive the price up rapidly.
          </li>
          <li>
            <strong>Borrowing costs:</strong> Short sellers must pay interest on borrowed
            shares, which can be substantial for hard-to-borrow stocks.
          </li>
          <li>
            <strong>Margin requirements:</strong> Brokers require short sellers to maintain
            margin accounts with sufficient collateral.
          </li>
        </ul>

        <h2>Short Selling Regulation in Australia</h2>
        <p>
          The Australian Securities and Investments Commission (ASIC) regulates short selling
          on the ASX. Key regulations include:
        </p>
        <ul>
          <li>
            <strong>Reporting requirements:</strong> Significant short positions must be
            reported to ASIC, which publishes aggregated data daily with a T+4 delay.
          </li>
          <li>
            <strong>Naked short selling prohibition:</strong> Selling shares without first
            arranging to borrow them is illegal.
          </li>
          <li>
            <strong>Disclosure obligations:</strong> Market participants must disclose
            substantial short positions.
          </li>
        </ul>

        <h2>Getting Started</h2>
        <p>
          Before engaging in short selling, investors should thoroughly understand the mechanics,
          risks, and regulatory requirements. Using tools like Shorted.com.au to track short
          positions can help identify heavily shorted stocks and potential opportunities.
        </p>
      </article>
    ),
  },
  "understanding-t4-delay": {
    title: "Understanding ASIC's T+4 Delay",
    description:
      "Learn why ASIC short position data is delayed by 4 trading days and how this affects your analysis. Includes tips for interpreting delayed data.",
    readTime: "5 min read",
    level: "Beginner",
    topics: ["ASIC", "Data Analysis", "T+4 Delay"],
    relatedArticles: ["what-is-short-selling", "how-to-read-short-interest"],
    faqs: [
      {
        question: "Why is ASIC short position data delayed?",
        answer:
          "ASIC delays short position data by 4 trading days (T+4) to protect market participants' trading strategies and prevent potential market manipulation. This gives reporting entities time to submit accurate data while maintaining market fairness.",
      },
      {
        question: "What does T+4 mean?",
        answer:
          "T+4 means 'Trade date plus four trading days'. If you're looking at short position data on a Friday, it reflects positions as of the previous Monday (excluding any non-trading days).",
      },
      {
        question: "How should I interpret delayed short data?",
        answer:
          "Focus on trends over time rather than single data points. Look for consistent increases or decreases in short positions over multiple days. The delay means the data shows historical sentiment, not current positions.",
      },
    ],
    content: (
      <article className="prose prose-slate dark:prose-invert max-w-none">
        <h2>What is the T+4 Delay?</h2>
        <p>
          When you view ASIC short position data on Shorted.com.au or any other platform, the
          information you see is not current - it reflects short positions from 4 trading days
          ago. This is known as the T+4 delay, where &quot;T&quot; stands for the trade date.
        </p>

        <h2>Why Does ASIC Delay the Data?</h2>
        <p>
          The delay serves several important purposes:
        </p>
        <ul>
          <li>
            <strong>Protect trading strategies:</strong> Immediate disclosure could allow other
            market participants to front-run or trade against reporting entities.
          </li>
          <li>
            <strong>Ensure accuracy:</strong> The delay gives market participants time to
            compile and submit accurate position reports.
          </li>
          <li>
            <strong>Prevent manipulation:</strong> Real-time data could be exploited to
            artificially move stock prices.
          </li>
          <li>
            <strong>Maintain fair markets:</strong> The delay creates a level playing field
            where no one has immediate access to short position changes.
          </li>
        </ul>

        <h2>How to Calculate the Reporting Date</h2>
        <p>
          To determine what date the short position data represents, count back 4 trading days
          (excluding weekends and public holidays):
        </p>
        <ul>
          <li>
            <strong>Friday publication:</strong> Reflects Monday&apos;s positions
          </li>
          <li>
            <strong>Thursday publication:</strong> Reflects previous Friday&apos;s positions
          </li>
          <li>
            <strong>Wednesday publication:</strong> Reflects previous Thursday&apos;s positions
          </li>
        </ul>

        <h2>Practical Implications</h2>
        <p>
          The T+4 delay has several implications for investors using short position data:
        </p>

        <h3>Focus on Trends</h3>
        <p>
          Rather than reacting to single data points, look for trends over multiple days or
          weeks. A consistent increase in short positions over several reporting periods is
          more meaningful than a single large change.
        </p>

        <h3>Anticipate News Events</h3>
        <p>
          If a company has earnings or other announcements, short position changes you see
          afterward may reflect positioning before the event, not reactions to it.
        </p>

        <h3>Combine with Other Indicators</h3>
        <p>
          Use short position data alongside other indicators like volume, price movement, and
          news flow. The combination provides a more complete picture than any single metric.
        </p>

        <h2>Key Takeaways</h2>
        <ul>
          <li>
            ASIC short position data is always 4 trading days old
          </li>
          <li>
            The delay protects market participants and ensures accuracy
          </li>
          <li>
            Focus on trends rather than single data points
          </li>
          <li>
            Combine with other analysis tools for best results
          </li>
        </ul>
      </article>
    ),
  },
  "how-to-read-short-interest": {
    title: "How to Read Short Interest Data",
    description:
      "Master the art of interpreting short interest percentages, changes over time, and what high or low short interest signals about market sentiment.",
    readTime: "10 min read",
    level: "Intermediate",
    topics: ["Short Interest", "Technical Analysis", "Market Sentiment"],
    relatedArticles: ["what-is-short-selling", "short-squeeze-mechanics"],
    faqs: [
      {
        question: "What is a high short interest percentage?",
        answer:
          "Generally, short interest above 10% is considered elevated, above 20% is very high, and above 30% is extreme. However, context matters - some sectors like mining typically have higher short interest than defensive sectors.",
      },
      {
        question: "Does high short interest mean a stock will go down?",
        answer:
          "Not necessarily. High short interest indicates bearish sentiment, but it can also lead to short squeezes if positive news emerges. Some investors see high short interest as a contrarian bullish indicator.",
      },
    ],
    content: (
      <article className="prose prose-slate dark:prose-invert max-w-none">
        <h2>Understanding Short Interest Metrics</h2>
        <p>
          Short interest is expressed as a percentage of total shares on issue. On Shorted.com.au,
          you&apos;ll see several key metrics for each stock.
        </p>

        <h3>Current Short Position %</h3>
        <p>
          This is the percentage of total issued shares currently held as short positions.
          For example, if a company has 100 million shares on issue and 10 million are
          shorted, the short interest is 10%.
        </p>

        <h3>Change Over Time</h3>
        <p>
          Tracking how short interest changes over days, weeks, and months reveals sentiment
          trends. Rising short interest suggests increasing bearishness; falling short
          interest suggests shorts are covering.
        </p>

        <h2>Interpreting Short Interest Levels</h2>
        <ul>
          <li>
            <strong>0-5%:</strong> Low short interest, typical for defensive stocks
          </li>
          <li>
            <strong>5-10%:</strong> Moderate short interest, normal range
          </li>
          <li>
            <strong>10-20%:</strong> Elevated, significant bearish sentiment
          </li>
          <li>
            <strong>20%+:</strong> Very high, potential squeeze candidate
          </li>
        </ul>

        <h2>What High Short Interest Tells You</h2>
        <p>
          High short interest can indicate several things:
        </p>
        <ul>
          <li>Professional investors believe the stock is overvalued</li>
          <li>There may be undisclosed problems at the company</li>
          <li>The stock faces headwinds (sector, economic, competitive)</li>
          <li>The stock is potentially a short squeeze candidate</li>
        </ul>

        <h2>Using Short Interest in Your Analysis</h2>
        <p>
          Never rely on short interest alone. Combine it with fundamental analysis, technical
          indicators, and news flow for a complete picture. Short sellers are often wrong,
          and high short interest can be a contrarian bullish signal when combined with
          positive catalysts.
        </p>
      </article>
    ),
  },
  "short-squeeze-mechanics": {
    title: "Short Squeeze Mechanics Explained",
    description:
      "Deep dive into how short squeezes occur, warning signs to watch for, and famous ASX short squeeze examples. Learn to identify potential squeeze candidates.",
    readTime: "12 min read",
    level: "Intermediate",
    topics: ["Short Squeeze", "Market Dynamics", "Trading Strategy"],
    relatedArticles: ["how-to-read-short-interest", "risk-management-shorted-stocks"],
    faqs: [
      {
        question: "What causes a short squeeze?",
        answer:
          "A short squeeze occurs when a heavily shorted stock rises in price, forcing short sellers to buy shares to cover their positions. This buying pressure drives the price higher, forcing more shorts to cover, creating a feedback loop.",
      },
      {
        question: "How can I identify potential short squeeze candidates?",
        answer:
          "Look for stocks with high short interest (above 20%), limited float, positive catalysts (earnings beats, contract wins), and increasing buying volume. Low days-to-cover ratios suggest shorts can exit quickly, reducing squeeze potential.",
      },
    ],
    content: (
      <article className="prose prose-slate dark:prose-invert max-w-none">
        <h2>What is a Short Squeeze?</h2>
        <p>
          A short squeeze is a rapid price increase caused by short sellers rushing to close
          their positions. As the price rises, more short sellers are forced to buy shares,
          creating a feedback loop that can send prices skyrocketing.
        </p>

        <h2>The Mechanics</h2>
        <ol>
          <li>
            <strong>Heavy short interest builds up:</strong> Many investors bet against a stock
          </li>
          <li>
            <strong>A catalyst triggers buying:</strong> Good news, earnings beat, or retail interest
          </li>
          <li>
            <strong>Price starts rising:</strong> Shorts face mounting losses
          </li>
          <li>
            <strong>Margin calls force covering:</strong> Brokers demand more collateral
          </li>
          <li>
            <strong>Buying begets buying:</strong> Covering shorts drive price higher
          </li>
          <li>
            <strong>Parabolic move:</strong> Price can spike dramatically
          </li>
        </ol>

        <h2>Identifying Squeeze Candidates</h2>
        <ul>
          <li>High short interest (20%+ of shares on issue)</li>
          <li>Limited float (fewer available shares)</li>
          <li>High days-to-cover ratio</li>
          <li>Positive fundamental catalysts</li>
          <li>Increasing volume and retail interest</li>
        </ul>

        <h2>Risks of Playing Squeezes</h2>
        <p>
          Short squeezes are extremely volatile and unpredictable. The same speed that drives
          prices up can reverse just as quickly when the squeeze ends. Most squeeze plays
          result in losses for late entrants who buy near the top.
        </p>
      </article>
    ),
  },
  "risk-management-shorted-stocks": {
    title: "Risk Management for Shorted Stocks",
    description:
      "Strategies for managing risk when trading heavily shorted stocks. Includes position sizing, stop losses, and portfolio considerations.",
    readTime: "15 min read",
    level: "Advanced",
    topics: ["Risk Management", "Portfolio Strategy", "Trading"],
    relatedArticles: ["short-squeeze-mechanics", "how-to-read-short-interest"],
    faqs: [
      {
        question: "How much of my portfolio should be in heavily shorted stocks?",
        answer:
          "Most financial advisors recommend limiting speculative positions to 5-10% of your total portfolio. Heavily shorted stocks fall into this category due to their higher volatility and risk.",
      },
      {
        question: "Should I use stop losses on heavily shorted stocks?",
        answer:
          "Stop losses can protect against large losses, but volatile shorted stocks often trigger stops before reversing. Consider using wider stops or position sizing instead for these volatile names.",
      },
    ],
    content: (
      <article className="prose prose-slate dark:prose-invert max-w-none">
        <h2>Understanding the Risks</h2>
        <p>
          Trading heavily shorted stocks carries unique risks including extreme volatility,
          rapid price movements, and potential for significant losses. Proper risk management
          is essential.
        </p>

        <h2>Position Sizing</h2>
        <p>
          The most important risk management tool is position sizing. For heavily shorted
          stocks:
        </p>
        <ul>
          <li>Limit individual positions to 2-5% of portfolio</li>
          <li>Reduce size for more volatile names</li>
          <li>Consider the total exposure to shorted stocks</li>
        </ul>

        <h2>Stop Loss Strategies</h2>
        <p>
          Traditional tight stops often don&apos;t work well with volatile stocks. Consider:
        </p>
        <ul>
          <li>Wider percentage-based stops (15-25%)</li>
          <li>Time-based exits</li>
          <li>Trailing stops to lock in gains</li>
        </ul>

        <h2>Portfolio Considerations</h2>
        <p>
          Balance speculative short-squeeze plays with more stable investments. Diversify
          across sectors and risk levels. Never invest more than you can afford to lose
          in any speculative position.
        </p>
      </article>
    ),
  },
  "sector-analysis-short-selling": {
    title: "Sector Analysis for Short Selling",
    description:
      "Learn which ASX sectors attract the most short selling activity and why. Understand cyclical patterns, sector-specific risks, and how to analyze short interest by industry.",
    readTime: "10 min read",
    level: "Intermediate",
    topics: ["Sector Analysis", "Industry Trends", "Market Cycles"],
    relatedArticles: ["how-to-read-short-interest", "short-squeeze-mechanics"],
    faqs: [
      {
        question: "Which ASX sectors have the highest short interest?",
        answer:
          "Mining (especially lithium and rare earths), speculative technology, retail, and energy sectors typically see higher short interest on the ASX. Defensive sectors like utilities and healthcare tend to have lower short interest.",
      },
      {
        question: "Why do some sectors attract more short selling?",
        answer:
          "Sectors with high volatility, commodity price exposure, regulatory uncertainty, or cyclical revenue patterns attract more short selling because they offer greater profit potential for bears betting on price declines.",
      },
    ],
    content: (
      <article className="prose prose-slate dark:prose-invert max-w-none">
        <h2>Understanding Sector Short Interest</h2>
        <p>
          Different ASX sectors attract varying levels of short selling activity. Understanding
          these patterns can help you identify opportunities and avoid potential pitfalls in
          your investment decisions.
        </p>

        <h2>High Short Interest Sectors</h2>
        <h3>Mining & Resources</h3>
        <p>
          The mining sector, particularly lithium, rare earths, and speculative explorers,
          consistently shows elevated short interest. This is driven by commodity price
          volatility, project execution risk, and the speculative nature of many junior miners.
        </p>

        <h3>Technology & Growth</h3>
        <p>
          High-growth tech companies often attract shorts due to elevated valuations,
          unprofitable business models, and sensitivity to interest rate changes. The
          &quot;growth at any cost&quot; narrative makes these stocks targets for value-focused shorts.
        </p>

        <h3>Retail & Consumer Discretionary</h3>
        <p>
          Retail stocks face structural challenges from e-commerce disruption, making them
          frequent short targets. Economic sensitivity and thin margins add to bearish
          sentiment during uncertain times.
        </p>

        <h2>Low Short Interest Sectors</h2>
        <h3>Utilities & Infrastructure</h3>
        <p>
          Regulated utilities with stable cash flows and dividend yields rarely attract
          significant short interest. Their defensive characteristics provide limited
          downside for shorts.
        </p>

        <h3>Healthcare & Pharmaceuticals</h3>
        <p>
          Established healthcare companies typically maintain low short interest due to
          inelastic demand and stable revenue. However, biotechs with binary clinical trial
          outcomes can see elevated short interest.
        </p>

        <h2>Cyclical Patterns</h2>
        <p>
          Short interest in cyclical sectors like mining and energy tends to increase
          when commodity prices peak and decrease during commodity price troughs. Understanding
          these cycles can help timing analysis of short positions.
        </p>

        <h2>Using Sector Analysis</h2>
        <ul>
          <li>Compare a stock&apos;s short interest to its sector average</li>
          <li>Look for divergences that might signal stock-specific issues</li>
          <li>Consider sector tailwinds/headwinds when evaluating short positions</li>
          <li>Monitor sector rotation and its impact on short interest trends</li>
        </ul>
      </article>
    ),
  },
  "building-a-watchlist": {
    title: "Building a Short Interest Watchlist",
    description:
      "How to create and maintain an effective watchlist of heavily shorted stocks. Learn filtering criteria, monitoring strategies, and when to act on short interest signals.",
    readTime: "8 min read",
    level: "Beginner",
    topics: ["Watchlists", "Stock Screening", "Monitoring"],
    relatedArticles: ["how-to-read-short-interest", "risk-management-shorted-stocks"],
    faqs: [
      {
        question: "How many stocks should be on my watchlist?",
        answer:
          "A focused watchlist of 15-30 stocks is usually manageable. This allows you to track positions closely without being overwhelmed. Quality over quantity—better to know a few stocks well than many superficially.",
      },
      {
        question: "What criteria should I use to filter stocks?",
        answer:
          "Common criteria include: minimum short interest threshold (e.g., >10%), minimum market cap for liquidity, specific sectors of interest, and recent short interest changes. Adjust based on your strategy.",
      },
    ],
    content: (
      <article className="prose prose-slate dark:prose-invert max-w-none">
        <h2>Why Build a Short Interest Watchlist?</h2>
        <p>
          A well-curated watchlist helps you track potential opportunities systematically.
          Rather than reacting to headlines, you can monitor stocks over time and act when
          conditions align with your strategy.
        </p>

        <h2>Setting Up Your Watchlist</h2>
        <h3>Step 1: Define Your Criteria</h3>
        <p>
          Before adding stocks, establish clear criteria:
        </p>
        <ul>
          <li><strong>Short interest threshold:</strong> Minimum percentage (e.g., 10%+)</li>
          <li><strong>Market cap range:</strong> Ensures adequate liquidity</li>
          <li><strong>Sector focus:</strong> Industries you understand well</li>
          <li><strong>Trend direction:</strong> Rising, falling, or stable short interest</li>
        </ul>

        <h3>Step 2: Screen for Candidates</h3>
        <p>
          Use the Top 100 page on Shorted.com.au to identify heavily shorted stocks.
          The industry pages help filter by sector. Look at both current levels and
          recent changes to spot emerging patterns.
        </p>

        <h3>Step 3: Research Each Stock</h3>
        <p>
          For each candidate, understand:
        </p>
        <ul>
          <li>Why is it heavily shorted? (Valid concerns or misunderstood?)</li>
          <li>What could prove the shorts wrong? (Catalysts)</li>
          <li>What&apos;s the fundamental story?</li>
          <li>What&apos;s the technical setup?</li>
        </ul>

        <h2>Monitoring Your Watchlist</h2>
        <h3>Daily Checks</h3>
        <ul>
          <li>Review short position changes from ASIC updates</li>
          <li>Check for company announcements</li>
          <li>Note unusual price or volume activity</li>
        </ul>

        <h3>Weekly Review</h3>
        <ul>
          <li>Assess short interest trends over the week</li>
          <li>Review any new stocks meeting your criteria</li>
          <li>Remove stocks that no longer qualify</li>
          <li>Update your notes on each position</li>
        </ul>

        <h2>When to Act</h2>
        <p>
          Don&apos;t trade just because a stock is on your watchlist. Wait for:
        </p>
        <ul>
          <li>Catalyst confirmation (news, earnings, etc.)</li>
          <li>Technical breakout or breakdown</li>
          <li>Significant short interest changes</li>
          <li>Risk/reward alignment with your strategy</li>
        </ul>
      </article>
    ),
  },
  "asx-short-selling-history": {
    title: "History of Short Selling on the ASX",
    description:
      "Explore the evolution of short selling regulation and notable events in Australian markets. From early regulations to modern ASIC reporting requirements.",
    readTime: "12 min read",
    level: "Beginner",
    topics: ["History", "Regulation", "Market Events"],
    relatedArticles: ["what-is-short-selling", "understanding-t4-delay"],
    faqs: [
      {
        question: "When did ASIC start publishing short position data?",
        answer:
          "ASIC began publishing daily aggregated short position data in 2010 following the Global Financial Crisis. Before this, short position data was not publicly available, making it difficult for retail investors to gauge market sentiment.",
      },
      {
        question: "Has short selling ever been banned in Australia?",
        answer:
          "Yes, during the 2008 Global Financial Crisis, ASIC temporarily banned short selling on financial stocks to stabilize markets. This ban was lifted once market conditions improved, though enhanced disclosure requirements remained.",
      },
    ],
    content: (
      <article className="prose prose-slate dark:prose-invert max-w-none">
        <h2>Early Days of Short Selling</h2>
        <p>
          Short selling has existed in various forms for centuries, but modern regulated
          short selling on the ASX developed alongside the broader evolution of
          Australian securities markets in the 20th century.
        </p>

        <h2>The Global Financial Crisis (2008)</h2>
        <p>
          The GFC marked a turning point for short selling regulation worldwide.
          In September 2008, ASIC banned covered short selling of financial stocks
          amid concerns that shorts were exacerbating the market crisis.
        </p>
        <p>
          Key changes following the GFC:
        </p>
        <ul>
          <li>Enhanced disclosure requirements for short positions</li>
          <li>Daily publication of aggregated short position data (from 2010)</li>
          <li>Stricter enforcement against naked short selling</li>
          <li>Improved transparency for retail investors</li>
        </ul>

        <h2>Modern ASIC Reporting (2010-Present)</h2>
        <p>
          Since 2010, market participants have been required to report significant short
          positions to ASIC. The introduction of daily T+4 reporting gave investors
          unprecedented visibility into market sentiment.
        </p>

        <h2>Notable ASX Short Squeezes</h2>
        <h3>Mining Boom Squeezes</h3>
        <p>
          Several junior miners experienced dramatic short squeezes during commodity
          price rallies, with some stocks rising 100%+ as shorts rushed to cover.
        </p>

        <h3>COVID-19 Era (2020-2021)</h3>
        <p>
          The post-COVID market rally caught many shorts off-guard, particularly in
          travel, retail, and technology sectors. The rapid recovery led to significant
          short covering and squeeze events.
        </p>

        <h2>Current Regulatory Framework</h2>
        <p>
          Today&apos;s framework balances market efficiency with investor protection:
        </p>
        <ul>
          <li>Daily T+4 disclosure of aggregated short positions</li>
          <li>$100,000 or 0.01% reporting threshold</li>
          <li>Prohibition on naked short selling</li>
          <li>Securities lending arrangements required before shorting</li>
        </ul>
      </article>
    ),
  },
  "securities-lending-explained": {
    title: "Securities Lending Explained",
    description:
      "Understand how securities lending works and its role in short selling. Learn about lending fees, risks, and how institutional investors participate in the lending market.",
    readTime: "10 min read",
    level: "Intermediate",
    topics: ["Securities Lending", "Institutional Trading", "Borrowing Costs"],
    relatedArticles: ["what-is-short-selling", "risk-management-shorted-stocks"],
    faqs: [
      {
        question: "What is securities lending?",
        answer:
          "Securities lending is the process where shareholders (typically institutions) temporarily lend their shares to borrowers (usually short sellers) in exchange for a fee. The borrower provides collateral and returns the shares later.",
      },
      {
        question: "Why do institutions lend their shares?",
        answer:
          "Institutions lend shares to earn additional income on holdings they plan to keep long-term. Superannuation funds and ETF providers commonly engage in securities lending to enhance returns for their members.",
      },
    ],
    content: (
      <article className="prose prose-slate dark:prose-invert max-w-none">
        <h2>What is Securities Lending?</h2>
        <p>
          Securities lending is the backbone of short selling. It&apos;s the process through
          which short sellers obtain the shares they need to sell. Without securities
          lending, short selling would be impossible.
        </p>

        <h2>How Securities Lending Works</h2>
        <ol>
          <li>
            <strong>Lender provides shares:</strong> An institutional investor (super fund,
            ETF, hedge fund) agrees to lend shares they own.
          </li>
          <li>
            <strong>Borrower provides collateral:</strong> The borrower deposits cash or
            securities as collateral, typically 102-105% of the share value.
          </li>
          <li>
            <strong>Lending fee paid:</strong> The borrower pays a fee to the lender,
            expressed as an annual percentage rate.
          </li>
          <li>
            <strong>Shares returned:</strong> Eventually, the borrower returns equivalent
            shares to the lender.
          </li>
        </ol>

        <h2>Understanding Borrowing Costs</h2>
        <h3>General Collateral (Easy to Borrow)</h3>
        <p>
          Most liquid, large-cap stocks are &quot;general collateral&quot; with borrowing costs
          of 0.25-0.5% annually. These are easy to borrow because many institutions
          hold and lend them.
        </p>

        <h3>Special/Hard to Borrow</h3>
        <p>
          Stocks with high short demand or limited supply can have borrowing costs of
          5-50%+ annually. In extreme cases, stocks may become unavailable to borrow.
        </p>

        <h3>Factors Affecting Borrowing Costs</h3>
        <ul>
          <li>Short interest level (higher = more expensive)</li>
          <li>Float size (smaller = harder to borrow)</li>
          <li>Institutional ownership (higher = more supply)</li>
          <li>Corporate actions (dividends, mergers affect supply)</li>
        </ul>

        <h2>Who Are the Lenders?</h2>
        <ul>
          <li><strong>Superannuation funds:</strong> Major source of lendable shares</li>
          <li><strong>ETF providers:</strong> Lend to offset fund costs</li>
          <li><strong>Insurance companies:</strong> Generate income on long-term holdings</li>
          <li><strong>Custodian banks:</strong> Facilitate lending for clients</li>
        </ul>

        <h2>Impact on Investors</h2>
        <p>
          Securities lending affects all market participants:
        </p>
        <ul>
          <li>Lenders earn extra income but lose voting rights temporarily</li>
          <li>Borrowers face ongoing costs that cut into profits</li>
          <li>High borrowing costs can discourage short selling</li>
          <li>Recall risk means lenders can demand shares back</li>
        </ul>
      </article>
    ),
  },
  "short-selling-vs-put-options": {
    title: "Short Selling vs Put Options: Key Differences",
    description:
      "Compare short selling with put options as bearish strategies. Understand the pros, cons, and use cases for each approach when betting against stocks.",
    readTime: "11 min read",
    level: "Advanced",
    topics: ["Options", "Trading Strategies", "Derivatives"],
    relatedArticles: ["what-is-short-selling", "risk-management-shorted-stocks"],
    faqs: [
      {
        question: "Which is safer - short selling or buying puts?",
        answer:
          "Buying puts has limited loss (the premium paid), while short selling has theoretically unlimited loss. However, puts have time decay working against them and may expire worthless. Neither is inherently 'safer' - they have different risk profiles.",
      },
      {
        question: "Can I short sell and buy puts on the same stock?",
        answer:
          "Yes, some traders use puts to hedge short positions (protective puts) or combine strategies for more complex positions. However, this requires understanding both instruments and can increase complexity and costs.",
      },
    ],
    content: (
      <article className="prose prose-slate dark:prose-invert max-w-none">
        <h2>Two Ways to Bet Against a Stock</h2>
        <p>
          When you believe a stock will decline, you have two main approaches: short
          selling the shares directly, or buying put options. Each has distinct
          characteristics that suit different situations.
        </p>

        <h2>Short Selling Characteristics</h2>
        <h3>Advantages</h3>
        <ul>
          <li>No time decay - position can be held indefinitely</li>
          <li>Profits increase linearly as stock falls</li>
          <li>No premium cost (though borrowing costs apply)</li>
          <li>Can be closed at any time during market hours</li>
        </ul>

        <h3>Disadvantages</h3>
        <ul>
          <li>Unlimited loss potential if stock rises</li>
          <li>Margin requirements tie up capital</li>
          <li>Borrowing costs can be substantial</li>
          <li>Risk of forced buyback if shares recalled</li>
          <li>Dividend payments owed to lender</li>
        </ul>

        <h2>Put Option Characteristics</h2>
        <h3>Advantages</h3>
        <ul>
          <li>Maximum loss limited to premium paid</li>
          <li>No margin account required</li>
          <li>No borrowing costs or dividend obligations</li>
          <li>Leverage - control more shares with less capital</li>
          <li>Can profit from increased volatility</li>
        </ul>

        <h3>Disadvantages</h3>
        <ul>
          <li>Time decay erodes value daily</li>
          <li>Premium cost must be overcome to profit</li>
          <li>Limited liquidity on some ASX options</li>
          <li>Requires correct timing, not just direction</li>
          <li>Options may expire worthless</li>
        </ul>

        <h2>When to Use Each Strategy</h2>
        <h3>Choose Short Selling When:</h3>
        <ul>
          <li>You expect a gradual decline over time</li>
          <li>Borrowing costs are low</li>
          <li>You can monitor the position closely</li>
          <li>You have adequate margin capacity</li>
        </ul>

        <h3>Choose Put Options When:</h3>
        <ul>
          <li>You expect a sharp decline in a defined timeframe</li>
          <li>You want to limit maximum loss</li>
          <li>The stock is hard or expensive to borrow</li>
          <li>You want leverage on your bearish view</li>
        </ul>

        <h2>Cost Comparison Example</h2>
        <p>
          Consider a $10 stock you believe will fall to $8:
        </p>
        <ul>
          <li><strong>Short 1,000 shares:</strong> $10,000 proceeds, target profit $2,000, risk unlimited</li>
          <li><strong>Buy 10 put contracts (strike $10):</strong> Maybe $500 premium, target profit $1,500 ($2,000 - $500), max loss $500</li>
        </ul>
        <p>
          The put offers better risk/reward if correct, but loses 100% if wrong on timing.
        </p>
      </article>
    ),
  },
  "reading-short-interest-changes": {
    title: "Interpreting Short Interest Changes Over Time",
    description:
      "Learn to analyze short interest trends and what rapid changes signal. Understand the difference between short covering, new short positions, and normal fluctuations.",
    readTime: "9 min read",
    level: "Intermediate",
    topics: ["Trend Analysis", "Short Covering", "Market Signals"],
    relatedArticles: ["how-to-read-short-interest", "short-squeeze-mechanics"],
    faqs: [
      {
        question: "What does a sudden drop in short interest mean?",
        answer:
          "A rapid decrease typically indicates short covering - shorts buying back shares to close positions. This could be due to thesis invalidation, stop-losses being hit, or anticipation of positive news. It can be bullish for the stock price.",
      },
      {
        question: "What causes short interest to spike suddenly?",
        answer:
          "Sudden increases usually mean new short positions being established. This could follow negative news, earnings disappointments, analyst downgrades, or sector-wide bearishness. It signals growing negative sentiment.",
      },
    ],
    content: (
      <article className="prose prose-slate dark:prose-invert max-w-none">
        <h2>Why Track Short Interest Over Time?</h2>
        <p>
          A single snapshot of short interest tells you little. The real insights come
          from tracking how short interest changes over days, weeks, and months.
          Trends reveal shifts in institutional sentiment before they show up in prices.
        </p>

        <h2>Types of Short Interest Changes</h2>
        <h3>Gradual Increase</h3>
        <p>
          When short interest rises slowly over several weeks, it typically indicates:
        </p>
        <ul>
          <li>Institutions building positions methodically</li>
          <li>Growing consensus on bearish thesis</li>
          <li>Potentially significant overhead resistance forming</li>
        </ul>

        <h3>Sudden Spike</h3>
        <p>
          A sharp increase in short interest often follows:
        </p>
        <ul>
          <li>Negative earnings or guidance</li>
          <li>Analyst downgrades</li>
          <li>Industry or macro concerns</li>
          <li>Fraud allegations or governance issues</li>
        </ul>

        <h3>Gradual Decrease</h3>
        <p>
          Slow decline in short interest may indicate:
        </p>
        <ul>
          <li>Shorts taking profits after price decline</li>
          <li>Original thesis playing out</li>
          <li>Reduced conviction among bears</li>
        </ul>

        <h3>Sudden Drop</h3>
        <p>
          Rapid short covering often triggers price spikes and may signal:
        </p>
        <ul>
          <li>Shorts capitulating on failed thesis</li>
          <li>Positive surprise invalidating bear case</li>
          <li>Technical breakout forcing covering</li>
          <li>Potential short squeeze dynamics</li>
        </ul>

        <h2>Analyzing Trends in Context</h2>
        <h3>Compare to Price Action</h3>
        <ul>
          <li>Rising short interest + falling price = shorts winning</li>
          <li>Rising short interest + rising price = shorts fighting the trend</li>
          <li>Falling short interest + rising price = short covering rally</li>
          <li>Falling short interest + falling price = shorts taking profits</li>
        </ul>

        <h3>Look at Relative Changes</h3>
        <p>
          A 1% change in short interest means more for a stock at 5% than one at 25%.
          Consider percentage changes relative to the base level.
        </p>

        <h2>Warning Signs to Watch</h2>
        <ul>
          <li>Divergence between short interest and price trends</li>
          <li>Short interest at multi-year highs or lows</li>
          <li>Rapid changes without obvious catalysts</li>
          <li>Sector-wide short interest movements</li>
        </ul>
      </article>
    ),
  },
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const article = articlesData[slug];

  if (!article) {
    return { title: "Article Not Found" };
  }

  return {
    title: `${article.title} | ${siteConfig.name}`,
    description: article.description,
    keywords: [...article.topics, "short selling guide", "ASX education", "ASIC data"],
    openGraph: {
      title: article.title,
      description: article.description,
      url: `${siteConfig.url}/learn/${slug}`,
      siteName: siteConfig.name,
      type: "article",
      locale: "en_AU",
    },
    twitter: {
      card: "summary_large_image",
      title: article.title,
      description: article.description,
    },
    alternates: {
      canonical: `${siteConfig.url}/learn/${slug}`,
    },
  };
}

export function generateStaticParams() {
  return Object.keys(articlesData).map((slug) => ({ slug }));
}

const levelColors = {
  Beginner: "bg-green-500/10 text-green-600 border-green-500/30",
  Intermediate: "bg-yellow-500/10 text-yellow-600 border-yellow-500/30",
  Advanced: "bg-red-500/10 text-red-600 border-red-500/30",
};

export default async function LearnArticlePage({ params }: PageProps) {
  const { slug } = await params;
  const article = articlesData[slug];

  if (!article) {
    notFound();
  }

  const breadcrumbItems = [
    { label: "Learn", href: "/learn" },
    { label: article.title, href: `/learn/${slug}` },
  ];

  const breadcrumbsSchema = [
    { name: "Home", url: siteConfig.url },
    { name: "Learn", url: `${siteConfig.url}/learn` },
    { name: article.title, url: `${siteConfig.url}/learn/${slug}` },
  ];

  const relatedArticles = article.relatedArticles
    .map((relatedSlug) => {
      const related = articlesData[relatedSlug];
      return related ? { slug: relatedSlug, ...related } : null;
    })
    .filter(Boolean);

  return (
    <DashboardLayout>
      <BreadcrumbListSchema items={breadcrumbsSchema} />
      <FAQStructuredData faqs={article.faqs} />

      <div className="max-w-4xl mx-auto">
        {/* Breadcrumbs */}
        <div className="mb-6">
          <Breadcrumbs items={breadcrumbItems} />
        </div>

        {/* Article Header */}
        <header className="mb-8 pb-8 border-b border-border/40">
          <div className="flex items-center gap-2 mb-4">
            <Badge
              variant="outline"
              className={levelColors[article.level as keyof typeof levelColors]}
            >
              {article.level}
            </Badge>
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              <Clock className="h-4 w-4" />
              {article.readTime}
            </span>
          </div>

          <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-4">
            {article.title}
          </h1>

          <p className="text-lg text-muted-foreground">{article.description}</p>

          <div className="flex flex-wrap gap-2 mt-4">
            {article.topics.map((topic) => (
              <span
                key={topic}
                className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground"
              >
                {topic}
              </span>
            ))}
          </div>
        </header>

        {/* Article Content */}
        <div className="mb-12">{article.content}</div>

        {/* FAQ Section */}
        {article.faqs.length > 0 && (
          <section className="mb-12 p-6 bg-muted/30 rounded-lg">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <BookOpen className="h-5 w-5 text-primary" />
              Frequently Asked Questions
            </h2>
            <div className="space-y-4">
              {article.faqs.map((faq, index) => (
                <div key={index}>
                  <h3 className="font-medium">{faq.question}</h3>
                  <p className="text-sm text-muted-foreground mt-1">{faq.answer}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Related Articles */}
        {relatedArticles.length > 0 && (
          <section className="mb-12">
            <h2 className="text-xl font-semibold mb-4">Continue Learning</h2>
            <div className="grid gap-4">
              {relatedArticles.map((related) =>
                related ? (
                  <Link key={related.slug} href={`/learn/${related.slug}`} className="group">
                    <div className="flex items-center gap-4 p-4 rounded-lg border border-border/60 hover:border-primary/50 transition-colors">
                      <GraduationCap className="h-5 w-5 text-primary flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium group-hover:text-primary transition-colors">
                          {related.title}
                        </div>
                        <div className="text-sm text-muted-foreground truncate">
                          {related.description}
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </Link>
                ) : null
              )}
            </div>
          </section>
        )}

        {/* Navigation */}
        <div className="flex justify-between pt-8 border-t border-border/40">
          <Link href="/learn">
            <Button variant="outline" className="flex items-center gap-2">
              <ChevronLeft className="h-4 w-4" />
              All Guides
            </Button>
          </Link>
          <Link href="/top">
            <Button className="flex items-center gap-2">
              View Top Shorts
              <ChevronRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </div>
    </DashboardLayout>
  );
}
