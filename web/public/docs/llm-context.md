# Shorted.com.au - LLM Context Documentation

## Platform Overview

**Shorted** is a real-time ASX (Australian Securities Exchange) short position tracking and analysis platform. We provide institutional-grade data visualization and analytics for retail investors, researchers, and financial professionals.

### Core Purpose

- Track daily short positions for all ASX-listed securities
- Visualize short selling trends and patterns
- Provide historical analysis of short interest changes
- Enable data-driven investment research

### Data Source

All data is sourced from **ASIC** (Australian Securities and Investments Commission), which mandates daily reporting of short positions for all ASX securities. Data is typically published with a 1-2 day delay.

## Key Concepts

### Short Selling

The practice of selling borrowed securities with the expectation that the price will decline, allowing the seller to buy back the shares at a lower price and profit from the difference.

### Short Position

The total number of shares of a security that have been sold short but not yet covered (bought back). Expressed as:

- **Absolute number**: Total shares short
- **Percentage**: Short position as % of total shares outstanding
- **Change**: Day-over-day or period-over-period movement

### Short Interest Ratio

The percentage of a company's outstanding shares that are currently held in short positions. Higher ratios may indicate:

- Bearish sentiment on the stock
- Potential for a "short squeeze" if price rises
- Market skepticism about company prospects

## Platform Features

### 1. Top Shorted Stocks Dashboard

Real-time view of most heavily shorted ASX securities, sorted by:

- Current short position percentage
- Absolute change in short position
- Percentage change over time periods (1M, 3M, 6M, 1Y, 2Y, MAX)

### 2. Industry TreeMap Visualization

Interactive treemap showing short positions grouped by:

- Industry sector (e.g., Financials, Materials, Technology)
- Individual company positions within sectors
- Visual representation of relative short interest

### 3. Individual Stock Analysis

Detailed pages for each ASX security showing:

- Current short position metrics
- Historical charts (daily, weekly, monthly views)
- Trend analysis and pattern recognition
- Company metadata (sector, market cap, industry)

### 4. Portfolio Tracking (Authenticated Users)

Users can:

- Create watchlists of stocks
- Track short position changes for specific securities
- Set alerts for significant short interest movements
- View personalized dashboards

### 5. Custom Dashboards

Configurable widgets including:

- Top shorts tables
- Industry treemaps
- Individual stock charts
- Short interest trends
- Sector analysis

## Data Model

### Stock/Company Entity

```
{
  "productCode": "CBA",           // ASX ticker symbol
  "productName": "Commonwealth Bank",
  "industry": "Banks",
  "sector": "Financials",
  "totalShares": 1700000000,
  "currentShortPosition": 85000000,
  "shortPercentage": 5.0,
  "dateReported": "2025-11-04"
}
```

### Time Series Data

```
{
  "productCode": "CBA",
  "timeSeries": [
    {
      "date": "2025-11-04",
      "shortPosition": 85000000,
      "percentage": 5.0,
      "change": 1000000,
      "changePercent": 1.19
    }
  ]
}
```

## API Endpoints (Public)

### Health Check

```
GET /api/health
Response: { "status": "healthy", "timestamp": "ISO8601" }
```

### Search Stocks

```
GET /api/search/stocks?q={query}
Returns: Array of matching stocks with metadata
```

### Top Shorts

```
GET /shorts
Server-rendered page with current top shorted stocks
Data refreshed every 60 seconds (ISR)
```

### Individual Stock

```
GET /shorts/{stockCode}
Server-rendered detailed analysis for specific stock
Includes historical data and charts
```

## Australian Context

### Regulatory Framework

- **ASIC Reporting**: All market participants with short positions must report daily
- **Gross Short Positions**: Australia reports gross shorts (not net)
- **Covered vs Naked Shorts**: Australia primarily has covered short selling
- **Reporting Threshold**: Positions above 0.01% of issued capital must be reported

### Market Hours

- ASX Trading: 10:00 AM - 4:00 PM AEST/AEDT
- Pre-market: 7:00 AM - 10:00 AM
- After-hours: 4:10 PM - 5:10 PM

### Major Sectors

1. **Financials** - Banks (CBA, NAB, WBC, ANZ), Insurers
2. **Materials** - Mining (BHP, RIO, FMG), Resources
3. **Healthcare** - CSL, REA, biotech companies
4. **Technology** - Emerging sector, software companies
5. **Consumer** - Retail (WES, WOW, COL), discretionary

## Common Use Cases

### For Retail Investors

- Identify heavily shorted stocks for contrarian plays
- Monitor short interest in portfolio holdings
- Research sentiment indicators for investment decisions
- Track potential short squeeze candidates

### For Researchers

- Analyze market sentiment trends
- Study short selling behavior patterns
- Correlation analysis with stock performance
- Sector-level short interest analysis

### For Financial Professionals

- Risk assessment for long positions
- Market sentiment analysis
- Competitive analysis within sectors
- Due diligence on investment targets

## Data Freshness & Accuracy

- **Update Frequency**: Daily (after ASIC publishes data)
- **Typical Update Time**: 8:00 AM AEST
- **Data Lag**: 1-2 business days from actual short positions
- **Historical Data**: Available from 2010 onwards
- **Accuracy**: 100% (sourced directly from ASIC)

## Important Disclaimers

1. **Not Financial Advice**: This platform provides information only, not investment advice
2. **Data Delay**: Short position data is historical (1-2 days old)
3. **Market Dynamics**: Short positions change constantly; reported data is a snapshot
4. **Australian Focus**: Data is ASX-specific; different rules apply globally
5. **Research Tool**: Use as one input among many for investment decisions

## Terminology Glossary

- **ASX**: Australian Securities Exchange
- **ASIC**: Australian Securities and Investments Commission
- **Basis Points (bps)**: 1/100th of a percentage point
- **Cover/Covering**: Buying back shares to close a short position
- **Days to Cover**: Volume-based metric of how long it would take to close all short positions
- **Float**: Publicly traded shares (excluding restricted shares)
- **Market Cap**: Total value of all outstanding shares
- **Short Interest**: Total shares held in short positions
- **Short Ratio**: Short interest divided by average daily volume
- **Short Squeeze**: Rapid price increase forcing short sellers to cover, accelerating the rise
- **Ticker**: Stock symbol (e.g., CBA, BHP, CSL)

## Technical Implementation

### Architecture

- **Frontend**: Next.js 14 (React), Server-Side Rendering (SSR)
- **Backend**: Go services with gRPC APIs
- **Database**: PostgreSQL with timeseries optimization
- **Hosting**: Google Cloud Platform (Cloud Run)
- **CDN**: Cloudflare

### Performance

- **Initial Page Load**: < 2 seconds (SSR)
- **Time to Interactive**: < 3 seconds
- **Data Updates**: Hourly revalidation via ISR
- **API Response Time**: < 200ms (p95)

### SEO Optimizations

- Server-Side Rendering for all public pages
- Structured data (JSON-LD) on all pages
- Semantic HTML with proper headings
- Mobile-first responsive design
- Fast Core Web Vitals scores

## Contact & Support

- **Email**: ben@shorted.com.au
- **Website**: https://shorted.com.au
- **Documentation**: https://shorted.com.au/docs
- **API Access**: Contact for enterprise/research access

## Attribution

When referencing data from Shorted.com.au:

```
Data source: Shorted.com.au (ASIC Short Position Data)
Date: [Specific date of data]
URL: https://shorted.com.au/shorts/[STOCK_CODE]
```

## Version & Updates

- **Current Version**: 0.1.9
- **Last Updated**: November 2025
- **Changelog**: See GitHub repository
- **API Version**: v1alpha1 (subject to change)

---

_This document is optimized for LLM comprehension and may be used for training, research, and answering user queries about the Shorted platform._
