export const siteConfig = {
  name: "Shorted",
  fullTitle: "Most Shorted ASX Stocks — Official ASIC Short Selling Data | Shorted",
  // Same title without the brand suffix — for OG/Twitter cards, where the brand
  // is already shown as the site name.
  socialTitle: "Most Shorted ASX Stocks — Official ASIC Short Selling Data",
  url: "https://shorted.com.au",
  ogImage: "https://shorted.com.au/opengraph-image",
  description:
    "Shorting the ASX starts with the data. Official ASIC short selling data for every ASX stock — the most shorted stocks, short interest trends and charts, updated daily (T+4).",
  shortDescription:
    "Official ASIC short position data for ASX stocks. Updated daily with T+4 delay. Track the most shorted stocks on the Australian market.",
  dataDisclaimer:
    "Data sourced from ASIC and published with a T+4 trading day delay. This information is for general purposes only and does not constitute financial advice.",
  keywords: [
    "shorting the ASX",
    "short the ASX",
    "ASIC short position data",
    "ASX short positions",
    "most shorted ASX stocks",
    "ASX short interest",
    "short selling Australia",
    "ASIC daily short positions",
    "short position tracker",
    "ASX short sales report",
  ],
  author: "Shorted Team",
  creator: "Shorted",
  publisher: "Shorted",
  links: {
    twitter: "https://twitter.com/shorted___",
    github: "https://github.com/shorted",
  },
  contact: {
    email: "support@shorted.com.au",
  },
};

export type SiteConfig = typeof siteConfig;
