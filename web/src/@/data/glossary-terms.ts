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
