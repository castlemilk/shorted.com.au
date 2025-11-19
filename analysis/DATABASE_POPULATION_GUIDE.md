# Database Population Guide

## ✅ Setup Complete

Your database is now set up with the complete schema:

- ✅ Migration 002: Company enrichment columns (tags, summary, key people, etc.)
- ✅ Migration 003: Financial statements column
- ✅ Migration 004: Financial report files tracking table
- ✅ Current data: 2000 companies, 4 already enriched

## 🗄️ Database Schema

### `company-metadata` Table
```
Base fields (from Payload CMS):
- stock_code (UNIQUE)
- company_name
- industry
- website
- summary, details
- company_logo_link

Enrichment fields (NEW):
- tags[]                    - Industry/technology tags
- enhanced_summary          - AI-generated concise summary
- company_history           - Brief history and milestones
- key_people (JSONB)        - CEO, CFO with bios
- financial_reports (JSONB) - Links to annual reports
- competitive_advantages    - What makes them unique
- risk_factors             - Business risks
- recent_developments      - Last 6 months news
- social_media_links (JSONB)
- logo_gcs_url             - GCS logo link
- enrichment_status        - 'pending', 'completed', 'failed'
- enrichment_date
- enrichment_error

Financial data (NEW):
- financial_statements (JSONB) - Yahoo Finance data
  - annual: {income_statement, balance_sheet, cash_flow}
  - quarterly: {...}
  - info: {market_cap, pe_ratio, eps, etc.}
```

### `financial_report_files` Table
```
- stock_code (FK)
- report_type              - 'annual_report', 'quarterly_report'
- report_date
- report_title
- source_url               - ORIGINAL (source of truth)
- gcs_url                 - OUR BACKUP (after sync)
- gcs_path
- file_size_bytes
- file_hash               - SHA256
- sync_status             - 'pending', 'uploaded', 'failed'
- crawler_source          - 'smart_crawler', 'asx_api', 'manual'
```

## 🚀 Population Script

The `enrich_database.py` script does everything:

1. **Fetches** company data from Payload CMS (including investor links)
2. **Crawls** investor pages for financial report PDFs
3. **Enriches** with GPT-4 (tags, summary, key people, risks, etc.)
4. **Fetches** Yahoo Finance data (income, balance sheet, cash flow)
5. **Saves** everything to the database
6. **Checkpoints** progress (resume if interrupted)

## 📋 Usage Examples

### Test Run (10 companies)
```bash
cd analysis
python enrich_database.py --limit 10
```

### Specific Companies
```bash
python enrich_database.py --stocks CBA BHP WBC ANZ NAB
```

### Process All Companies
```bash
python enrich_database.py --all
```

### Resume After Interruption
```bash
python enrich_database.py --all --resume
```

## ⚙️ Configuration

Set environment variables or edit the script defaults:

```bash
export OPENAI_API_KEY="sk-proj-..."
export CMS_DATABASE_URL="postgresql://..."
export DATABASE_URL="postgresql://..."
```

Current values:
- OpenAI API Key: `sk-proj-Abm5Q...` (already configured)
- CMS Database: PayloadCMS Postgres (read-only)
- Target Database: Main Postgres (postgresql://postgres.xivfykscsdagwsreyqgf...)

## 📊 What Gets Populated

### For Each Company:

1. **AI-Generated Content (GPT-4)**
   - 5 industry/technology tags
   - Enhanced 2-3 sentence summary
   - Brief company history
   - CEO & CFO with bios
   - Competitive advantages
   - 3-5 business risk factors
   - Recent developments (last 6 months)
   - LinkedIn/Twitter links

2. **Financial Report PDFs (Smart Crawler)**
   - Crawls investor relations pages
   - Finds annual/quarterly reports
   - Extracts title, date, type
   - Saves to `financial_report_files` table
   - Sets status='pending' for GCS sync

3. **Financial Statements (Yahoo Finance)**
   - Income statement (4-5 years annual)
   - Balance sheet (4-5 years annual)
   - Cash flow (4-5 years annual)
   - Current metrics: market cap, P/E, EPS, dividend yield, etc.
   - Stored as JSONB in `financial_statements` column

4. **Metadata**
   - GCS logo URL
   - Enrichment status & timestamp
   - Error messages (if any)

## 💰 Cost Estimates

### Per Company:
- **GPT-4**: ~$0.01-0.02 (2000 tokens @ $10/1M output)
- **Yahoo Finance**: FREE
- **Web Crawling**: FREE
- **Database**: FREE (already provisioned)

### Full Database (2000 companies):
- **GPT-4**: ~$20-40 total
- **Time**: ~2-3 hours (2 seconds per company + API time)
- **Storage**: ~400MB of JSON data

## 📈 Progress Tracking

### Check Status
```bash
psql $DATABASE_URL -c "
SELECT 
    enrichment_status,
    COUNT(*) as count
FROM \"company-metadata\"
GROUP BY enrichment_status;
"
```

### View Sample Enriched Company
```bash
psql $DATABASE_URL -c "
SELECT 
    stock_code,
    company_name,
    array_length(tags, 1) as tag_count,
    LENGTH(enhanced_summary) as summary_length,
    jsonb_array_length(key_people) as people_count,
    jsonb_array_length(financial_reports) as report_count,
    enrichment_date
FROM \"company-metadata\"
WHERE enrichment_status = 'completed'
LIMIT 5;
"
```

### Check Financial Reports
```bash
psql $DATABASE_URL -c "
SELECT 
    stock_code,
    COUNT(*) as report_count
FROM financial_report_files
GROUP BY stock_code
ORDER BY report_count DESC
LIMIT 10;
"
```

## 🔧 Troubleshooting

### No Reports Found
- Check PayloadCMS has investor links
- Verify links are not social media
- Try running crawler on specific company manually

### GPT Enrichment Failed
- Check OpenAI API key is valid
- Verify API quota/rate limits
- Look at `enrichment_error` column for details

### Yahoo Finance Failed
- Some small companies don't have Yahoo data
- Expected coverage: 80-90%
- Not an error, just data availability

### Database Connection Error
- Verify DATABASE_URL is correct
- Check network connectivity
- Ensure migrations have been run

## 🎯 Next Steps After Population

1. **Sync Financial Reports to GCS**
   ```bash
   python sync_reports_to_gcs.py --all
   ```

2. **Validate Data Quality**
   - Check enrichment coverage
   - Review sample enrichments
   - Identify gaps

3. **Update Frontend**
   - Query enriched data
   - Display company profiles
   - Show financial statements
   - Link to reports

4. **Schedule Regular Updates**
   - Weekly: Re-enrich recently active companies
   - Monthly: Update financial statements
   - Quarterly: Re-crawl for new reports

## 🚦 Quick Start Commands

```bash
# Install dependencies
cd /Users/benebsworth/projects/shorted/analysis
pip install -r requirements.txt

# Test with 5 companies
python enrich_database.py --limit 5

# Check results
psql $DATABASE_URL -c "
SELECT stock_code, enrichment_status, array_length(tags, 1) as tags
FROM \"company-metadata\" 
WHERE enrichment_status = 'completed' 
ORDER BY enrichment_date DESC 
LIMIT 5;
"

# If tests look good, process all
python enrich_database.py --all
```

## 📞 Support

If you encounter issues:
1. Check `enrichment_checkpoint.json` for progress
2. Look at `enrichment_error` column in database
3. Run with `--limit 1` to debug single company
4. Verify all environment variables are set

Ready to populate! 🚀

