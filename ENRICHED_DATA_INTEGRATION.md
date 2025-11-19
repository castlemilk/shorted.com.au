# Enriched Company Metadata - Stock View Integration

## Overview

The enriched company metadata is now fully integrated into the stock view, providing users with comprehensive AI-generated insights throughout the interface.

## What's Been Enhanced

### 1. **CompanyProfile Component** (`web/src/@/components/ui/companyProfile.tsx`)

**New Features:**
- ✨ **AI Enhancement Indicator**: Shows a sparkle icon when enriched data is available
- 🏷️ **Industry Tags**: Displays the first 2 AI-generated specialty tags (e.g., "lithium mining", "renewable energy")
- 📝 **Enhanced Summary**: Uses `enhanced_summary` (AI-generated) instead of basic summary when available
- ✂️ **Smart Truncation**: Limits summary to 200 characters for better card layout

**Visual Changes:**
```tsx
// Before: Only basic data
{stockCode}
{companyName}
{industry badge}
{basic summary}

// After: Enriched data integration
{stockCode} ✨ (if enriched)
{companyName}
{industry badge} {tag1 badge} {tag2 badge}
{enhanced_summary (truncated)}
```

### 2. **CompanyInfo Component** (`web/src/@/components/ui/companyInfo.tsx`)

**New Features:**
- 🔗 **Social Media Links**: Shows LinkedIn, Twitter, Facebook, YouTube icons (when enriched)
- 📍 **Better Layout**: Improved spacing and visual hierarchy
- 🎨 **Interactive Icons**: Hover effects on social media links

**Visual Changes:**
```tsx
// Added new section
Connect
[LinkedIn] [Twitter] [Facebook] [YouTube]
```

### 3. **CompanyFinancials Component** ✨ NEW (`web/src/@/components/ui/companyFinancials.tsx`)

**Features:**
- 💰 **Market Cap**: Formatted in B/M/K notation
- 💵 **Current Price**: Latest stock price
- 📊 **P/E Ratio**: Price-to-earnings ratio
- 💹 **EPS**: Earnings per share
- 💸 **Dividend Yield**: As percentage
- 👥 **Employee Count**: Total employees

**Smart Formatting:**
- Currency values: `$1.23B`, `$456.78M`, `$12.34K`
- Numbers: `1,234,567` (with thousands separator)
- Percentages: `2.45%`
- Only shows when enriched financial data is available

### 4. **Stock Page Layout** (`web/src/app/shorts/[stockCode]/page.tsx`)

**Structure:**
```
┌─────────────────────────────────────────────────────────┐
│ Left Sidebar (1/3)      │ Main Content (2/3)            │
├─────────────────────────┼───────────────────────────────┤
│ CompanyProfile ✨       │ Short Position Trends         │
│  - Logo & Name          │  - Chart                      │
│  - Tags & Industry      │                               │
│  - Enhanced Summary     │                               │
│                         │                               │
│ CompanyStats            │ Historical Price Data         │
│  - Short %              │  - Market Chart               │
│  - Short Positions      │                               │
│  - Total Shares         │                               │
│                         │                               │
│ CompanyInfo             │ Enriched Company Insights ✨  │
│  - Website              │  - Tags & Overview            │
│  - Industry             │  - Company History            │
│  - Address              │  - Key People                 │
│  - Social Links ✨      │  - Financial Reports          │
│                         │  - Competitive Advantages     │
│ CompanyFinancials ✨    │  - Risk Factors               │
│  - Market Cap           │  - Recent Developments        │
│  - Price, P/E, EPS      │                               │
│  - Dividend Yield       │                               │
│  - Employee Count       │                               │
└─────────────────────────┴───────────────────────────────┘
```

## Data Flow

### Backend (Go)
```
services/shorts/internal/store/shorts/postgres.go
│
└─> GetStockDetails(stockCode)
    ├─> Basic fields (company_name, industry, website, etc.)
    ├─> Enriched fields (tags[], enhanced_summary, company_history, etc.)
    ├─> Key people (JSONB)
    ├─> Financial reports (JSONB)
    ├─> Social media links (JSONB)
    └─> Financial statements (JSONB)
```

### Frontend (Next.js)
```
app/actions/getStockDetails.ts
│
└─> Fetches StockDetails via gRPC-Web
    │
    ├─> CompanyProfile (shows tags, enhanced summary, AI indicator)
    ├─> CompanyInfo (shows social links)
    ├─> CompanyFinancials (shows financial metrics)
    └─> EnrichedCompanySection (shows full enriched content)
```

## Conditional Rendering

All enriched features use smart conditional rendering:

```tsx
const isEnriched = stockDetails.enrichmentStatus === "completed";

// Only show enriched features when data is available
{isEnriched && enrichedFeature}
```

This ensures:
- ✅ No errors for non-enriched companies
- ✅ Graceful degradation to basic data
- ✅ Progressive enhancement as data becomes available

## User Experience Benefits

### Before Enrichment
- Basic company name and industry
- Simple text summary
- Website and address only
- No financial metrics

### After Enrichment ✨
- AI-enhanced summary with depth and context
- Industry specialty tags for quick identification
- Social media presence for engagement
- Key financial metrics at a glance
- Visual indicator (sparkle icon) showing enriched status
- Comprehensive insights section with:
  - Company history and milestones
  - Leadership team profiles
  - Financial report links
  - Competitive analysis
  - Risk assessment
  - Recent news

## Enrichment Status

The system tracks enrichment status per company:

- `pending`: Awaiting enrichment
- `completed`: ✨ Full enriched data available
- `failed`: Enrichment encountered an error

Only companies with `completed` status show enriched features.

## SEO & Performance

### Server-Side Rendering
All components use Next.js Server Components for:
- ⚡ Fast initial page load
- 🔍 SEO-friendly content
- 📱 Better mobile performance

### Incremental Static Regeneration
```tsx
export const revalidate = 3600; // 1 hour
```

Pages are regenerated hourly to balance:
- Fresh data
- Build performance
- CDN caching

## Database Schema

The enriched data is stored in the `company-metadata` table:

```sql
-- Enriched fields
tags TEXT[]                     -- AI-generated industry tags
enhanced_summary TEXT           -- Comprehensive AI summary
company_history TEXT           -- Timeline and milestones
key_people JSONB               -- Leadership with bios
financial_reports JSONB        -- Links to reports
competitive_advantages TEXT    -- Market strengths
risk_factors TEXT              -- Business risks
recent_developments TEXT       -- Latest news
social_media_links JSONB       -- Social profiles
financial_statements JSONB     -- Yahoo Finance data
enrichment_status VARCHAR(50)  -- 'pending', 'completed', 'failed'
enrichment_date TIMESTAMP      -- Last enrichment
```

## Testing

To test the enriched view:

1. **Find an enriched company:**
```bash
# Check database for enriched companies
psql -d shorted -c "SELECT stock_code, company_name, enrichment_status 
FROM \"company-metadata\" 
WHERE enrichment_status = 'completed' 
LIMIT 10;"
```

2. **Visit the stock page:**
```
http://localhost:3000/shorts/BHP
```

3. **Look for:**
- ✨ Sparkle icon next to stock code
- Industry tags below company name
- Social media icons in "About" section
- "Key Metrics" card with financial data
- "Company Insights" section with detailed information

## Future Enhancements

Potential improvements:
- 📈 Real-time enrichment status updates
- 🔔 Notifications when enrichment completes
- 🎯 Filtering stocks by enrichment status
- 🔍 Search by enriched tags
- 📊 Enrichment coverage dashboard
- 🤖 Manual enrichment trigger button

## Related Files

- `web/src/@/components/ui/companyProfile.tsx` - Company header with tags
- `web/src/@/components/ui/companyInfo.tsx` - Basic info + social links
- `web/src/@/components/ui/companyFinancials.tsx` - Financial metrics
- `web/src/@/components/company/enriched-company-section.tsx` - Full insights
- `web/src/@/components/company/company-overview.tsx` - Overview cards
- `web/src/@/components/company/key-people.tsx` - Leadership team
- `web/src/@/components/company/financial-reports.tsx` - Report links
- `web/src/app/actions/company-metadata.ts` - Data fetching
- `web/src/@/types/company-metadata.ts` - TypeScript types
- `services/shorts/internal/store/shorts/postgres.go` - Backend queries
- `proto/shortedtypes/stocks/v1alpha1/stocks.proto` - gRPC definitions

## Summary

The enriched company metadata is now seamlessly integrated throughout the stock view, providing users with:
- 🎯 **Quick Insights**: Tags and enhanced summaries in sidebar cards
- 💰 **Financial Metrics**: Key financial data at a glance
- 🔗 **Social Presence**: Direct links to company social media
- 📊 **Deep Analysis**: Comprehensive insights in dedicated section
- ✨ **Visual Indicators**: Clear indication of enriched data availability

This creates a professional, information-rich experience that helps users make better-informed investment decisions.


