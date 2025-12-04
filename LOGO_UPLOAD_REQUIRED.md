# Company Logos - Upload Required

## Issue

The company profile pages are showing fallback icons instead of logos because **the logo files don't exist in Google Cloud Storage yet**.

## Root Cause

- ✅ Database has correct GCS URLs: `https://storage.googleapis.com/shorted-company-logos/logos/{STOCK_CODE}.svg`
- ❌ Actual logo files haven't been uploaded to GCS yet
- ❌ GCS URLs return 404 Not Found

### Example

```bash
curl -I "https://storage.googleapis.com/shorted-company-logos/logos/BHP.svg"
# Returns: HTTP/2 404
```

## Database State

```sql
SELECT stock_code, company_name, logo_gcs_url 
FROM "company-metadata" 
WHERE stock_code = 'BHP';

 stock_code |   company_name    |                            logo_gcs_url                            
------------+-------------------+--------------------------------------------------------------------
 BHP        | BHP GROUP LIMITED | https://storage.googleapis.com/shorted-company-logos/logos/BHP.svg
```

## Solution Options

### Option 1: Upload Logos to GCS (Recommended)

Upload the logo files to the `shorted-company-logos` GCS bucket:

```bash
# Assuming you have logo files locally
gsutil -m cp logos/*.svg gs://shorted-company-logos/logos/

# Or upload individual files
gsutil cp BHP.svg gs://shorted-company-logos/logos/BHP.svg
```

### Option 2: Make Bucket Public (If Not Already)

Ensure the GCS bucket has public read access:

```bash
# Make bucket publicly readable
gsutil iam ch allUsers:objectViewer gs://shorted-company-logos

# Or set CORS policy
cat > cors.json <<EOF
[
  {
    "origin": ["*"],
    "method": ["GET"],
    "responseHeader": ["Content-Type"],
    "maxAgeSeconds": 3600
  }
]
EOF

gsutil cors set cors.json gs://shorted-company-logos
```

### Option 3: Source Logos from Payload CMS

If logos exist in Payload CMS, sync them:

```python
import requests
from google.cloud import storage

# Fetch companies from Payload
companies = requests.get("https://your-payload-cms.com/api/companies").json()

# Upload to GCS
client = storage.Client()
bucket = client.bucket("shorted-company-logos")

for company in companies:
    if company.get("logo_url"):
        # Download from original source
        logo_data = requests.get(company["logo_url"]).content
        
        # Upload to GCS
        blob = bucket.blob(f"logos/{company['stock_code']}.svg")
        blob.upload_from_string(logo_data)
        print(f"Uploaded {company['stock_code']}")
```

### Option 4: Update Database with Valid URLs

If logos exist elsewhere, update the database:

```sql
-- Example: Use logo URLs from another source
UPDATE "company-metadata"
SET logo_gcs_url = 'https://example.com/logos/' || stock_code || '.svg'
WHERE logo_gcs_url IS NOT NULL;
```

## Current Behavior

The component correctly handles missing logos:

1. Tries to load image from `logo_gcs_url`
2. If load fails (404, CORS, etc.), `onError` handler triggers
3. Sets `imageError` state to `true`
4. Falls back to showing `IdCardIcon` placeholder

### Code Flow

```tsx
// web/src/@/components/ui/company-logo.tsx
export function CompanyLogo({ gcsUrl, companyName, stockCode }: CompanyLogoProps) {
  const [imageError, setImageError] = useState(false);

  if (!gcsUrl || imageError) {
    return <IdCardIcon />; // Fallback
  }

  return (
    <img 
      src={gcsUrl}
      onError={() => setImageError(true)} // Triggers on 404
    />
  );
}
```

## Testing After Upload

Once logos are uploaded:

1. Clear browser cache
2. Hard refresh (Cmd+Shift+R / Ctrl+Shift+F5)
3. Visit http://localhost:3020/shorts/BHP
4. Logo should now display instead of icon

## Verification

Check if a logo exists:

```bash
# Should return 200 OK
curl -I "https://storage.googleapis.com/shorted-company-logos/logos/BHP.svg"
```

## Related Files

- `web/src/@/components/ui/company-logo.tsx` - Logo component with fallback
- `web/src/@/components/ui/companyProfile.tsx` - Uses CompanyLogo component
- `services/shorts/internal/store/shorts/postgres.go` - Fetches logo_gcs_url from DB
- `supabase/migrations/002_enrich_company_metadata.sql` - Added logo_gcs_url column

## Next Steps

1. **Upload logo files to GCS** or
2. **Update database with valid logo URLs** or
3. **Continue using fallback icons** (current state)

The logo display system is working correctly - it just needs the actual logo files to exist in GCS!



