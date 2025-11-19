# Company Metadata Enrichment - Complete Workflow

## ✅ Database Setup Complete

Migrations have been applied:
- ✅ Migration 002: Enrichment columns (tags, summary, reports, etc.)
- ✅ Migration 003: Financial statements column
- ✅ Migration 004: Financial report files tracking table

## 🔄 Two-Stage Workflow

### Stage 1: Interactive Exploration (Jupyter Notebook)

**Purpose**: Test and validate GPT-5 outputs before running full batch

**File**: `explore-enrichment.ipynb`

**What it does**:
1. Test enrichment on a single company (e.g., CBA)
2. Inspect GPT-4 outputs (tags, summary, key people, risks)
3. Validate financial reports crawler
4. Check Yahoo Finance data quality
5. Test batch processing on 10 companies
6. Export sample results for review

**Run it**:
```bash
cd /Users/benebsworth/projects/shorted/analysis
jupyter notebook explore-enrichment.ipynb
```

**Key Features**:
- ✅ Interactive - see results immediately
- ✅ Adjustable - tweak prompts and test
- ✅ Safe - doesn't modify database unless you uncomment save cells
- ✅ Visual - rich display of all enrichment data

### Stage 2: Full Batch Processing (Python Script)

**Purpose**: Process all ~2000 companies and populate database

**File**: `enrich_database.py`

**What it does**:
1. Fetches all companies from Payload CMS
2. For each company:
   - Crawls investor pages for financial reports
   - Enriches with GPT-4 (tags, summary, key people, etc.)
   - Fetches Yahoo Finance data (income, balance sheet, cash flow)
   - Saves to database
3. Checkpoints progress every 10 companies
4. Resumable if interrupted

**Run it**:
```bash
cd /Users/benebsworth/projects/shorted/analysis

# Test with 10 companies first
python enrich_database.py --limit 10

# Check results
psql $DATABASE_URL -c "
SELECT stock_code, enrichment_status, array_length(tags, 1) as tag_count
FROM \"company-metadata\" 
WHERE enrichment_status = 'completed' 
ORDER BY enrichment_date DESC 
LIMIT 10;
"

# If happy, process all companies
python enrich_database.py --all

# Or resume if interrupted
python enrich_database.py --all --resume
```

**Monitoring Progress**:
```bash
# Watch enrichment status
watch -n 5 'psql $DATABASE_URL -c "
SELECT enrichment_status, COUNT(*) 
FROM \"company-metadata\" 
GROUP BY enrichment_status;
"'

# Check checkpoint file
cat enrichment_checkpoint.json
```

## 🐛 Connection Issues Fixed

**Problem**: "max clients reached - in Session mode"

**Solution**: Implemented connection pooling
- Created singleton engine instances
- Reuse connections across operations
- Limited pool size to 5 connections
- Prevent "max clients" errors

**Changes in `enrich_database.py`**:
```python
# Before (created new engine each time - BAD)
engine = create_engine(DATABASE_URL)

# After (reuse singleton engine - GOOD)
engine = get_target_engine()  # Returns same engine instance
```

## 📊 Expected Results Per Company

After enrichment, each company will have:

### GPT-4 Generated:
- **tags**: 5 industry/technology tags
- **enhanced_summary**: 2-3 sentence concise summary
- **company_history**: Brief history and milestones
- **key_people**: CEO, CFO with bios (JSON array)
- **competitive_advantages**: What makes them unique
- **risk_factors**: 3-5 business risks (JSON array)
- **recent_developments**: Last 6 months news
- **social_media_links**: LinkedIn, Twitter (JSON object)

### Crawler Found:
- **financial_reports**: 5-10 annual/quarterly reports (JSON array)
  - Each with: title, date, type, source_url
  - Saved to `financial_report_files` table for GCS sync

### Yahoo Finance:
- **financial_statements**: Complete financial data (JSON object)
  - Income statement (4-5 years)
  - Balance sheet (4-5 years)
  - Cash flow (4-5 years)
  - Current metrics (market cap, P/E, EPS, etc.)

### Metadata:
- **logo_gcs_url**: GCS logo link
- **enrichment_status**: 'completed' or 'failed'
- **enrichment_date**: Timestamp
- **enrichment_error**: Error message (if failed)

## ⏱️ Time & Cost Estimates

### Full Database (2000 companies):

| Stage | Time | Cost |
|-------|------|------|
| Web Crawling | ~1 hour | FREE |
| GPT-4 Enrichment | ~1.5 hours | $20-40 |
| Yahoo Finance | ~1 hour | FREE |
| **Total** | **~3-4 hours** | **$20-40** |

**Per company**: ~6-8 seconds + $0.01-0.02

**Rate limiting**: 2 seconds between companies (be nice to APIs)

## 📈 Post-Processing Steps

### 1. Validate Results
```bash
# Check completion rate
psql $DATABASE_URL -c "
SELECT 
    enrichment_status,
    COUNT(*) as count,
    ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) as percentage
FROM \"company-metadata\"
GROUP BY enrichment_status;
"

# Check data quality
psql $DATABASE_URL -c "
SELECT 
    COUNT(*) as total,
    COUNT(CASE WHEN array_length(tags, 1) >= 5 THEN 1 END) as has_tags,
    COUNT(CASE WHEN jsonb_array_length(financial_reports) > 0 THEN 1 END) as has_reports,
    COUNT(CASE WHEN financial_statements IS NOT NULL THEN 1 END) as has_financials
FROM \"company-metadata\"
WHERE enrichment_status = 'completed';
"
```

### 2. Sync Reports to GCS
```bash
# Sync all financial report PDFs to Google Cloud Storage
python sync_reports_to_gcs.py --all

# Check sync status
psql $DATABASE_URL -c "
SELECT sync_status, COUNT(*) 
FROM financial_report_files 
GROUP BY sync_status;
"
```

### 3. Export for Review
```bash
# Export enriched companies to JSON
psql $DATABASE_URL -c "
COPY (
  SELECT 
    stock_code,
    company_name,
    tags,
    enhanced_summary,
    jsonb_array_length(key_people) as people_count,
    jsonb_array_length(financial_reports) as report_count
  FROM \"company-metadata\"
  WHERE enrichment_status = 'completed'
  LIMIT 100
) TO STDOUT WITH (FORMAT csv, HEADER true);
" > enriched_companies_sample.csv
```

## 🔄 Re-Running Enrichment

### Update Specific Companies
```bash
# Re-enrich specific companies
python enrich_database.py --stocks CBA BHP WBC

# This will overwrite existing enrichment
```

### Resume After Failure
```bash
# If process was interrupted, resume from checkpoint
python enrich_database.py --all --resume

# This skips already processed companies
```

### Clear Checkpoint (Start Fresh)
```bash
rm enrichment_checkpoint.json
python enrich_database.py --all
```

## 🎯 Quick Start Commands

```bash
# 1. CD to analysis directory
cd /Users/benebsworth/projects/shorted/analysis

# 2. Explore in Jupyter (RECOMMENDED FIRST STEP)
jupyter notebook explore-enrichment.ipynb
# Run cells, inspect outputs, validate quality

# 3. Small test batch
python enrich_database.py --limit 10

# 4. Check test results
psql $DATABASE_URL -c "
SELECT stock_code, enrichment_status, array_length(tags, 1) 
FROM \"company-metadata\" 
WHERE enrichment_date > NOW() - INTERVAL '1 hour'
ORDER BY enrichment_date DESC;
"

# 5. If satisfied, run full batch
python enrich_database.py --all

# 6. Monitor progress (in another terminal)
watch -n 10 'psql $DATABASE_URL -c "
SELECT enrichment_status, COUNT(*) 
FROM \"company-metadata\" 
GROUP BY enrichment_status;
"'

# 7. Sync reports to GCS
python sync_reports_to_gcs.py --all
```

## 📞 Troubleshooting

### Connection Errors
✅ **FIXED** - Connection pooling implemented

### No Reports Found
- Check company has investor links in Payload CMS
- Try different company (some don't have online reports)
- Expected: 60-70% will have reports

### GPT Enrichment Fails
- Check OpenAI API key is valid
- Verify API quota/rate limits
- Look at `enrichment_error` column

### Yahoo Finance Fails
- Expected: 10-20% won't have Yahoo data
- Small/new companies often missing
- Not an error, just data availability

## 🚀 Ready to Go!

1. ✅ Database migrations applied
2. ✅ Connection pooling fixed
3. ✅ Jupyter notebook created for exploration
4. ✅ Batch script ready for production
5. ✅ GCS sync script ready

**Start with Jupyter, then run the batch!**

