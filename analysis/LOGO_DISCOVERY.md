# Logo Discovery System

## Overview

The enhanced logo discovery system (`enhanced_logo_discovery.py`) finds company logos from multiple sources and uploads them to GCS for use in the Shorted app.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  EnhancedLogoDiscovery                      │
│  Main orchestrator - tries each fetcher in order           │
└─────────────────────┬───────────────────────────────────────┘
                      │
     ┌────────────────┼────────────────┬────────────────┐
     ▼                ▼                ▼                ▼
┌──────────┐   ┌──────────────┐   ┌──────────┐   ┌──────────┐
│ Clearbit │   │WebsiteCrawler│   │ Google   │   │DuckDuck  │
│ Fetcher  │   │  (primary)   │   │ Favicon  │   │Go Search │
└──────────┘   └──────────────┘   └──────────┘   └──────────┘
                      │
     ┌────────────────┴────────────────┐
     ▼                                 ▼
┌──────────────────┐          ┌──────────────────┐
│ Image Scoring    │          │ Best Logo        │
│ - logo keywords  │          │ Selection        │
│ - header/nav     │          │ - quality score  │
│ - size           │          │ - vector bonus   │
└──────────────────┘          │ - size bonus     │
                              └──────────────────┘
                                       │
                                       ▼
                              ┌──────────────────┐
                              │ Upload to GCS    │
                              │ shorted-company- │
                              │ logos bucket     │
                              └──────────────────┘
```

## Logo Sources (in priority order)

1. **Clearbit Logo API** (`https://logo.clearbit.com/{domain}`)
   - Free, domain-based lookup
   - High quality when available
   - Often fails for Australian companies

2. **Website Crawler** (most successful)
   - Crawls company homepage + common pages (/about, /press, etc.)
   - Looks for: `<img>` with logo classes, inline SVGs, og:image, favicons
   - Scoring algorithm identifies best logo candidates
   - **Key fix**: Uses Referer header for sites that block direct image requests

3. **Google Favicon Service** (`https://www.google.com/s2/favicons?domain={domain}&sz=128`)
   - Reliable fallback
   - Lower resolution (128x128)

4. **DuckDuckGo Instant Answer**
   - Sometimes has company icons
   - Variable reliability

5. **ASX Company Profile**
   - Scrapes ASX listing pages
   - Limited logo availability

## Common Issues & Solutions

### Issue: 403 Forbidden on Image Fetch
**Symptom**: Website loads but images return 403
**Cause**: Server blocks direct image requests (hotlink protection)
**Solution**: Add `Referer` header matching the page URL
```python
# Fixed in fetch_image() - now auto-retries with Referer header
response = self.client.get(url, headers={'Referer': page_url})
```

### Issue: Website Returns 403/Forbidden
**Symptom**: Entire site returns 403
**Cause**: Cloudflare/WAF blocking, site misconfigured, or error page
**Investigation**:
```python
# Check if content is real page or error
response = client.get(url)
soup = BeautifulSoup(response.content)
title = soup.find('title')  # "CNAME Cross-User Banned" = error page
```
**Solution**: May need correct website URL or manual intervention

### Issue: DNS/Connection Errors
**Symptom**: `ConnectError: nodename nor servname provided`
**Cause**: Domain doesn't exist (company delisted/acquired)
**Investigation**: Search for company status
**Solution**: Mark as `delisted` in database, update website if new company exists

### Issue: Company Acquired/Merged
**Examples**:
- AKE (Allkem) → merged into Arcadium Lithium (LTM)
- WSA (Western Areas) → acquired by IGO
- KDY (Kaddy) → delisted (dormant)
**Solution**: Mark as `delisted`, update enrichment_status

### Issue: Website URL Outdated
**Example**: BEO had `skyfii.io` but rebranded to `beonic.com`
**Investigation**: Search for company + ASX code
**Solution**: Update website field in database

## Debugging Commands

### Test single stock discovery
```bash
python3 enhanced_logo_discovery.py --stock ABC
```

### Check website accessibility
```python
import httpx
client = httpx.Client(timeout=15, follow_redirects=True,
    headers={'User-Agent': 'Mozilla/5.0...'})
response = client.get('https://example.com')
print(f'Status: {response.status_code}')
print(f'Content-Type: {response.headers.get("content-type")}')
```

### Analyze page for logos
```python
from bs4 import BeautifulSoup
soup = BeautifulSoup(response.content, 'html.parser')

# Find logo candidates
for img in soup.find_all('img'):
    classes = img.get('class', [])
    src = img.get('src', '')
    if 'logo' in str(classes).lower() or 'logo' in src.lower():
        print(f'{src}: classes={classes}')
```

### Test image fetch with Referer
```python
# Without Referer (may fail)
response = client.get(image_url)

# With Referer (usually works)
response = client.get(image_url, headers={'Referer': 'https://example.com/'})
```

## Batch Processing

### Discover logos for stocks missing them
```bash
python3 enhanced_logo_discovery.py --batch --limit 50
```

### Discover and upload to GCS
```bash
python3 enhanced_logo_discovery.py --batch --limit 50 --upload
```

### Discover, upload, and update database
```bash
python3 enhanced_logo_discovery.py --batch --limit 50 --upload --update-db
```

## GCS Upload Process

1. Logo is converted to PNG format
2. Uploaded to `gs://shorted-company-logos/logos/{STOCK_CODE}.png`
3. Made public via ACL
4. Database `logo_gcs_url` updated with public URL

### Manual GCS upload (if script fails)
```bash
# Activate service account
gcloud auth activate-service-account \
  --key-file="/path/to/shorted-dev-aba5688f-*.json"

# Upload logo
gsutil cp logo.png gs://shorted-company-logos/logos/ABC.png
```

## Database Queries

### Find stocks needing logos
```sql
SELECT stock_code, company_name, website
FROM "company-metadata"
WHERE enrichment_status = 'completed'
  AND website IS NOT NULL AND website != ''
  AND (logo_gcs_url IS NULL OR logo_gcs_url = '');
```

### Check logo coverage
```sql
SELECT
    enrichment_status,
    COUNT(*) as total,
    COUNT(CASE WHEN logo_gcs_url IS NOT NULL THEN 1 END) as has_logo,
    ROUND(COUNT(CASE WHEN logo_gcs_url IS NOT NULL THEN 1 END)::numeric / COUNT(*) * 100, 1) as pct
FROM "company-metadata"
GROUP BY enrichment_status;
```

### Update logo URL
```sql
UPDATE "company-metadata"
SET logo_gcs_url = 'https://storage.googleapis.com/shorted-company-logos/logos/ABC.png'
WHERE stock_code = 'ABC';
```

### Mark stock as delisted
```sql
UPDATE "company-metadata"
SET enrichment_status = 'delisted'
WHERE stock_code = 'XYZ';
```

## Key Files

| File | Purpose |
|------|---------|
| `analysis/enhanced_logo_discovery.py` | Main discovery script |
| `analysis/upload_logos_gsutil.sh` | Batch upload helper |
| `analysis/sync-logos.py` | Sync GCS logos to database |
| `analysis/data/discovered_logos/` | Discovered logos storage |
| `services/shorted-dev-aba5688f-*.json` | GCP service account key |

## Scoring Algorithm

Images are scored based on:
- **+30**: "logo", "brand", "mark", "emblem", "identity" in class/id/alt/src
- **+20**: Image in `<header>` or `<nav>` element
- **+15**: Parent element has logo-related class
- **+15**: SVG format (vector bonus)
- **-20**: Explicit width/height < 32px

Minimum score threshold: **>20** to be considered a logo candidate.

## Best Logo Selection

Best logo is chosen by:
1. Highest quality score
2. Vector format bonus (+20)
3. Size bonus (larger = better, up to +30)
4. Format preference: SVG > PNG > JPEG

## Maintenance Tasks

### Weekly
- Check for new stocks without logos
- Run batch discovery for pending stocks

### When adding new company
1. Add to company-metadata table
2. Run single-stock discovery
3. Verify logo quality manually if needed

### When company is acquired/delisted
1. Mark as `delisted` in database
2. Update website if successor company exists
3. Note in data quality report
