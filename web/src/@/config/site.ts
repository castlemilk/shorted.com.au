export const siteConfig = {
  name: "Shorted",
  fullTitle: "Shorted | Official ASIC Short Position Data for ASX Stocks",
  url: "https://shorted.com.au",
  ogImage: "https://shorted.com.au/opengraph-image",
  description:
    "Track short selling positions on the ASX using official ASIC data (T+4 delayed). Free daily updates, interactive charts, industry heatmaps, and analysis of the most shorted Australian stocks.",
  shortDescription:
    "Official ASIC short position data for ASX stocks. Updated daily with T+4 delay. Track the most shorted stocks on the Australian market.",
  dataDisclaimer:
    "Data sourced from ASIC and published with a T+4 trading day delay. This information is for general purposes only and does not constitute financial advice.",
  keywords: [
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
    twitter: "https://twitter.com/shorted",
    github: "https://github.com/shorted",
  },
  contact: {
    email: "support@shorted.com.au",
  },
};

export type SiteConfig = typeof siteConfig;
