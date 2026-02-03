# Company Metadata Data Quality Report (Production)

Generated: 2026-02-03 (Updated after enhanced logo discovery)

## Executive Summary

The production `company-metadata` table contains **4,452 records**. After cleanup and enhanced logo discovery, records are properly categorized by status. **568 stocks (12.8%) are fully enriched** with **82.2% logo coverage** for enriched stocks.

### Key Metrics (After Enhanced Logo Discovery)

| Metric | Before | After Cleanup | After Logo Discovery | Change |
|--------|--------|---------------|---------------------|--------|
| Total Records | 4,452 | 4,452 | 4,452 | - |
| Fully AI-Enriched | 569 | 568 | 568 | - |
| Pending Enrichment | 3,883 | 1,013 | 1,013 | - |
| Stale (No Activity 1yr) | 0 | 2,400 | 2,400 | - |
| Not Applicable (ETF/CDI) | 0 | 470 | 470 | - |
| Delisted | 0 | 1 | 1 | - |
| Have Logo (Total) | 1,796 | 1,966 | **1,987** | +21 |
| Logo Coverage (Total) | 40.3% | 44.2% | **44.6%** | +0.4% |
| Logo Coverage (Enriched) | - | - | **82.2%** | New |
| Logo Coverage (Pending) | - | - | **83.1%** | New |

### Logo Discovery Sources (Multi-Source Approach)

The enhanced logo discovery system uses multiple sources:
1. **Clearbit Logo API** - Domain-based logo lookup
2. **Google Favicon Service** - High-quality favicons
3. **DuckDuckGo Instant Answer** - Search-based discovery
4. **ASX Company Profile** - Official ASX pages
5. **Website Crawling** - Logo/favicon extraction from company sites
6. **OpenGraph Images** - Social media thumbnails

Batch discovery achieved **80% success rate** (20/25 logos found).

### Cleanup Actions Performed

1. **Marked 384 ETFs** as `not_applicable`
2. **Marked 60 Hybrids/Notes** as `not_applicable`
3. **Marked 26 CDIs** as `not_applicable`
4. **Marked 2,400 stale records** (no short data in 365 days) as `stale`
5. **Marked Z1P as delisted** (old ticker, replaced by ZIP)
6. **Synced 267 logos** from GCS to database (were already in GCS but not reflected in DB)
7. **Discovered 21 new logos** via enhanced multi-source discovery and uploaded to GCS

## Field Completeness

| Field | Populated | Missing | % Complete |
|-------|-----------|---------|------------|
| company_name | 4,452 | 0 | 100.0% |
| industry | 2,206 | 2,246 | 49.6% |
| website | 2,005 | 2,447 | 45.0% |
| summary | 2,000 | 2,452 | 44.9% |
| logo_gcs_url | 1,796 | 2,656 | 40.3% |
| enhanced_summary | 569 | 3,883 | 12.8% |
| company_history | 569 | 3,883 | 12.8% |
| risk_factors | 569 | 3,883 | 12.8% |

## Stock Type Breakdown

| Type | Total | Enriched | Has Industry | Has Logo |
|------|-------|----------|--------------|----------|
| Regular Stock | 3,973 | 560 (14%) | 2,206 (56%) | 1,796 (45%) |
| ETF/Fund | 390 | 6 | 0 | 0 |
| Hybrid/Note | 60 | 0 | 0 | 0 |
| CDI/Foreign | 29 | 3 | 0 | 0 |

**Note:** ETFs, Hybrids, and CDIs don't need individual enrichment - consider marking as `not_applicable`.

## Enriched Stocks with Missing Data

Of the 568 enriched stocks, some have gaps:

| Issue | Count |
|-------|-------|
| Missing industry | 101 |
| Missing website | 100 |
| Missing logo | **101** (down from 126) |
| Missing summary | 110 |

### Enriched but Missing Logo (with website - can fetch)

Only **4 enriched stocks** have websites but no logos (AKE, KDY, WSA failed discovery):

| Stock | Company | Industry | Website | Status |
|-------|---------|----------|---------|--------|
| AKE | Allkem | - | allkem.co | Discovery failed |
| KDY | Kaddy Limited | - | kaddy.com.au | Discovery failed |
| NBL | Noni B | - | nonib.com.au | SVG only |
| WSA | Western Areas | - | westernareas.com.au | Discovery failed |

**Previously fetched (now have logos):** ABP, GYG, NAN, ZIP, DMP, EDV, ANN

## Priority Enrichment Queue

### High Priority (>5% Short Interest, Pending)

Only **2 stocks** with >5% short interest still need enrichment:

| Stock | Company | Short % | Has Industry | Has Logo |
|-------|---------|---------|--------------|----------|
| LYC | Lynas Rare Earths | 8.39% | ✓ | ✓ |
| LOTDB | Lotus Resources | 6.97% | ✓ | ❌ |

### Moderate Priority (2-5% Short Interest, Pending)

31 stocks with moderate short interest need enrichment. Most already have industry and logo:

| Stock | Company | Short % | Missing |
|-------|---------|---------|---------|
| ORA | Orora | 3.22% | - |
| ARB | Arb Corporation | 3.11% | - |
| BOT | Botanix Pharma | 3.08% | - |
| LTR | Liontown | 3.07% | - |
| AOV | Amotiv | 2.43% | logo |
| LLC | Lendlease Group | 2.14% | logo |
| SS1 | Sun Silver | 2.09% | logo |

## Data Quality Issues

### Potential Duplicates

```
ZIP - Zip Co Limited..
Z1P - Zip Co Ltd.
```
These may be the same company with different tickers (old vs new).

### Stale Records (No Activity in 365 Days)

Some stocks in metadata have no recent short data - may be delisted:

| Stock | Company | Status |
|-------|---------|--------|
| 1PG | 1-Page | pending |
| 1ST | 1st Group | pending |
| 3DM | 3d Medical | pending |
| TDIDC | 360 Capital Digital | pending |
| 4DXNA | 4dmedical | pending |
| ACBR | A-Cap Energy Rights | pending |

## Recommendations

### 1. Logo Fetching (29 stocks)
Run logo fetch for enriched stocks that have a website but no logo:
- ABP, AKE, ANN, ANP, ARL, ANG, API, CCV, ADI, DMP, EDC, EDV, GTK, GDM, GYG, KDY, KTD, LLL, LBY, LNW, NAN, NCM, NBL, OML, OZL, WSA, ZIP, Z1P

### 2. Complete Enrichment (2 stocks)
Priority enrichment for high-short stocks:
- LYC (Lynas Rare Earths) - 8.39% short
- LOTDB (Lotus Resources) - 6.97% short, needs logo

### 3. Mark ETFs as N/A
```sql
UPDATE "company-metadata"
SET enrichment_status = 'not_applicable'
WHERE company_name ILIKE '%etf%'
   OR company_name ILIKE '%units%';
```

### 4. Clean Up Duplicates
Investigate ZIP vs Z1P - may need to merge or mark one as obsolete.

### 5. Archive Stale Records
Mark stocks with no activity in 1+ year as potentially delisted.

## SQL Queries

### Get Next Logo Fetch Batch
```sql
SELECT stock_code, company_name, website
FROM "company-metadata"
WHERE enrichment_status = 'completed'
  AND (logo_gcs_url IS NULL OR logo_gcs_url = '')
  AND website IS NOT NULL AND website != ''
ORDER BY company_name;
```

### Get Next Enrichment Batch
```sql
WITH latest_shorts AS (
    SELECT DISTINCT ON ("PRODUCT_CODE")
        "PRODUCT_CODE" as code,
        "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" as short_pct
    FROM shorts
    WHERE "DATE" >= (CURRENT_DATE - INTERVAL '30 days')
    ORDER BY "PRODUCT_CODE", "DATE" DESC
)
SELECT cm.stock_code, cm.company_name, ROUND(ls.short_pct::numeric, 2) as short_pct
FROM "company-metadata" cm
JOIN latest_shorts ls ON cm.stock_code = ls.code
WHERE cm.enrichment_status = 'pending'
  AND cm.company_name NOT ILIKE '%etf%'
  AND ls.short_pct > 2
ORDER BY ls.short_pct DESC;
```

### Find Stale Records
```sql
WITH recent_shorts AS (
    SELECT DISTINCT "PRODUCT_CODE" as code
    FROM shorts
    WHERE "DATE" >= (CURRENT_DATE - INTERVAL '365 days')
)
SELECT cm.stock_code, cm.company_name
FROM "company-metadata" cm
LEFT JOIN recent_shorts rs ON cm.stock_code = rs.code
WHERE rs.code IS NULL
  AND cm.company_name NOT ILIKE '%etf%';
```
