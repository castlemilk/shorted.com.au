## Financial Report Storage & Sync Workflow

## 🎯 Goal

Create a reliable system that:
1. **Stores original URLs** (source of truth - can verify/re-download)
2. **Backs up to GCS** (reliable, fast access for our users)
3. **Tracks sync status** (know what's been backed up)
4. **Maintains integrity** (SHA256 hashes verify files haven't changed)

## 📊 Architecture

```
┌──────────────────┐
│  Smart Crawler   │ ──► Finds report URLs on investor pages
└──────────────────┘
         │
         ▼
┌──────────────────┐
│    Database      │ ──► Stores: source_url (original)
│  financial_      │     Status: pending
│  report_files    │
└──────────────────┘
         │
         ▼
┌──────────────────┐
│  Sync Script     │ ──► Downloads from source_url
│  (Python)        │     Uploads to GCS
└──────────────────┘
         │
         ▼
┌──────────────────┐
│  Google Cloud    │ ──► Stores backup copy
│  Storage         │     Path: STOCK_CODE/YYYY-type-hash.pdf
└──────────────────┘
         │
         ▼
┌──────────────────┐
│    Database      │ ──► Updates: gcs_url, file_hash, file_size
│  (Updated)       │     Status: uploaded
└──────────────────┘
```

## 🗄️ Database Schema

Two storage options:

### Option A: Dedicated Table (Recommended)
```sql
financial_report_files:
  - id (PK)
  - stock_code (FK)
  - report_type ('annual_report', 'quarterly_report', etc.)
  - report_date
  - source_url (ORIGINAL - source of truth)
  - gcs_url (OUR BACKUP)
  - gcs_path ('CBA/2024-annual-report-abc123.pdf')
  - file_size_bytes
  - file_hash (SHA256)
  - sync_status ('pending', 'uploaded', 'failed')
  - sync_attempts
  - created_at
  - updated_at
```

### Option B: JSONB in company-metadata
```json
{
  "type": "annual_report",
  "title": "2024 Annual Report",
  "date": "2024-06-30",
  "source_url": "https://company.com/report.pdf",  // ORIGINAL
  "gcs_url": "https://storage.googleapis.com/.../", // BACKUP
  "gcs_synced_at": "2025-01-15T10:00:00Z",
  "file_size": 1234567,
  "file_hash": "abc123...",
  "source": "smart_crawler"
}
```

## 🚀 Implementation Steps

### Step 1: Run Migration (2 minutes)

```bash
cd /Users/benebsworth/projects/shorted
psql $DATABASE_URL -f supabase/migrations/004_add_financial_reports_storage.sql
```

This creates:
- `financial_report_files` table
- Indexes for performance
- Views for tracking sync status

### Step 2: Setup GCS Bucket (5 minutes)

```bash
# Create GCS bucket
gsutil mb -p shorted-dev gs://shorted-financial-reports/

# Set lifecycle policy (optional - delete old versions after 90 days)
cat > lifecycle.json << EOF
{
  "lifecycle": {
    "rule": [
      {
        "action": {"type": "Delete"},
        "condition": {"age": 90}
      }
    ]
  }
}
EOF
gsutil lifecycle set lifecycle.json gs://shorted-financial-reports/

# Set permissions (make publicly readable or keep private)
# Public (anyone can download):
gsutil iam ch allUsers:objectViewer gs://shorted-financial-reports/

# OR Private (only authenticated users):
# (default, no command needed)
```

### Step 3: Update Enrichment Pipeline - Cell 6

When crawler finds reports, insert into database:

```python
# In fetch_annual_reports function, after finding reports:

def save_reports_to_database(stock_code: str, reports: List[Dict]) -> int:
    """
    Save discovered reports to database for later GCS sync.
    """
    engine = create_engine(DATABASE_URL)
    saved_count = 0
    
    with engine.connect() as conn:
        for report in reports:
            # Check if already exists
            check_query = text("""
                SELECT id FROM financial_report_files 
                WHERE stock_code = :stock_code AND source_url = :source_url
            """)
            
            existing = conn.execute(check_query, {
                'stock_code': stock_code,
                'source_url': report['url']
            }).fetchone()
            
            if not existing:
                # Insert new report
                insert_query = text("""
                    INSERT INTO financial_report_files (
                        stock_code, report_type, report_date, report_title,
                        source_url, source_domain, crawler_source, sync_status
                    ) VALUES (
                        :stock_code, :report_type, :report_date, :report_title,
                        :source_url, :source_domain, :crawler_source, 'pending'
                    )
                """)
                
                from urllib.parse import urlparse
                domain = urlparse(report['url']).netloc
                
                conn.execute(insert_query, {
                    'stock_code': stock_code,
                    'report_type': report.get('type', 'annual_report'),
                    'report_date': report.get('date'),
                    'report_title': report.get('title'),
                    'source_url': report['url'],
                    'source_domain': domain,
                    'crawler_source': report.get('source', 'smart_crawler')
                })
                
                conn.commit()
                saved_count += 1
    
    return saved_count

# After crawling, save reports
reports = crawl_for_reports(investor_link, stock_code)
saved = save_reports_to_database(stock_code, reports)
print(f"  💾 Saved {saved} new reports to database")
```

### Step 4: Run Sync Script

```bash
cd analysis

# Install dependencies
pip install google-cloud-storage
echo "google-cloud-storage>=2.0.0" >> requirements.txt

# Setup GCP credentials
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account-key.json"
export GCS_FINANCIAL_REPORTS_BUCKET="shorted-financial-reports"

# Sync all pending reports
python sync_reports_to_gcs.py

# Or sync specific companies
python sync_reports_to_gcs.py --stocks CBA BHP WBC

# Or sync first 10 only (testing)
python sync_reports_to_gcs.py --limit 10
```

### Step 5: Schedule Regular Syncs (Optional)

Add to cron or Cloud Scheduler:

```bash
# Sync new reports daily at 2 AM
0 2 * * * cd /path/to/analysis && python sync_reports_to_gcs.py >> sync.log 2>&1
```

## 📈 Usage in Web App

### Display Reports with Fallback

```typescript
// frontend/components/FinancialReports.tsx
interface Report {
  title: string;
  date: string;
  source_url: string;  // Original URL
  gcs_url?: string;    // Our backup
  file_size: number;
}

function ReportLink({ report }: { report: Report }) {
  // Prefer GCS URL (faster, more reliable), fallback to source
  const downloadUrl = report.gcs_url || report.source_url;
  
  return (
    <a href={downloadUrl} target="_blank" rel="noopener noreferrer">
      {report.title}
      {report.gcs_url && <span className="badge">Backed up</span>}
    </a>
  );
}
```

### Query Reports

```sql
-- Get all backed-up reports for a company
SELECT 
    report_type,
    report_title,
    report_date,
    source_url,
    gcs_url,
    file_size_bytes / 1024.0 / 1024.0 as size_mb
FROM financial_report_files
WHERE stock_code = 'CBA'
  AND sync_status = 'uploaded'
ORDER BY report_date DESC;

-- Get sync statistics
SELECT 
    sync_status,
    COUNT(*) as count,
    ROUND(SUM(file_size_bytes) / 1024.0 / 1024.0 / 1024.0, 2) as total_gb
FROM financial_report_files
GROUP BY sync_status;
```

## 💰 Cost Estimates

### Google Cloud Storage Costs (Australia/Sydney)

| Item | Cost | Notes |
|------|------|-------|
| Storage | $0.023/GB/month | ~2,000 PDFs @ 2MB avg = 4GB = $0.09/mo |
| Download (egress) | $0.19/GB | 1,000 downloads/mo @ 2MB = 2GB = $0.38/mo |
| Operations | $0.004/1000 ops | Upload = $8 one-time for 2,000 files |

**Total**: ~$0.50/month ongoing + $8 one-time upload

### Workflow Costs

| Phase | Cost | Time |
|-------|------|------|
| Crawl & discover URLs | FREE | Included in enrichment |
| Store URLs in DB | FREE | Postgresql storage |
| Download PDFs (one-time) | FREE | Public downloads |
| Upload to GCS (one-time) | $8 | 2,000 files |
| Monthly storage | $0.50 | 4GB of PDFs |
| Monthly downloads | $0.38 | 1,000 downloads |

## 🔍 Monitoring

### Check Sync Status

```bash
# How many reports are synced?
psql $DATABASE_URL -c "
SELECT sync_status, COUNT(*) 
FROM financial_report_files 
GROUP BY sync_status;
"

# Failed syncs?
psql $DATABASE_URL -c "
SELECT stock_code, report_title, sync_error 
FROM financial_report_files 
WHERE sync_status = 'failed' 
LIMIT 10;
"

# Storage usage?
psql $DATABASE_URL -c "
SELECT 
    COUNT(*) as total_reports,
    ROUND(SUM(file_size_bytes) / 1024.0 / 1024.0, 2) as total_mb
FROM financial_report_files 
WHERE sync_status = 'uploaded';
"
```

## 🎯 Benefits

### Source URL (Original)
- ✅ Source of truth - can verify report is authentic
- ✅ Can re-download if our copy is corrupted
- ✅ Provides attribution (good for compliance)
- ❌ May break/change over time
- ❌ Slower to load (external server)

### GCS URL (Backup)
- ✅ Fast delivery (Google CDN)
- ✅ Reliable (99.99% uptime)
- ✅ We control it (won't change/break)
- ✅ Can add metadata, analytics
- ❌ Costs ~$0.50/month
- ❌ Need to keep in sync

### Both = Best of Both Worlds
- ✅ Fast, reliable delivery via GCS
- ✅ Fallback to source if GCS fails
- ✅ Can verify file integrity
- ✅ Re-sync if source updates

## 🚀 Ready to Implement!

1. ✅ Migration created: `004_add_financial_reports_storage.sql`
2. ✅ Sync script: `sync_reports_to_gcs.py`
3. ✅ Integration steps documented
4. ✅ Cost estimates provided

**Follow the 5 steps above to implement the complete workflow!**

