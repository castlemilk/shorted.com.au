# Logo Sync Tool

A simple utility to sync company logos from Google Cloud Storage to the local database without running the full enrichment pipeline.

## Overview

This tool checks which stock logos exist in GCS and updates the `logo_gcs_url` field in the `company-metadata` table accordingly.

## Usage

### Full Sync (All Stocks)

```bash
cd analysis
python3 sync-logos.py
```

### Dry Run (Preview Changes)

```bash
python3 sync-logos.py --dry-run
```

### Limited Sync (Test First N Stocks)

```bash
python3 sync-logos.py --limit 20
```

## What It Does

1. **Fetches** all stock codes from the database
2. **Checks** if each stock has a logo in GCS (`.png` format)
3. **Updates** the `logo_gcs_url` field for stocks with logos

## GCS Logo Location

- **Base URL**: `https://storage.googleapis.com/shorted-company-logos/logos/`
- **Format**: `{STOCK_CODE}.png` (uppercase)
- **Example**: `BHP.png`, `DMP.png`, `PLS.png`

## Backend Configuration

The backend (`services/shorts/internal/store/shorts/postgres.go`) is configured to:
- ✅ **ONLY** serve logos from GCS (`logo_gcs_url`)
- ❌ **NO** fallback to external URLs (`company_logo_link`)
- 🎯 Show default icon if no GCS logo exists

## Current Status (as of sync)

- **Total stocks**: 2,000
- **Logos in GCS**: 1,833 (92%)
- **Missing logos**: 167 (8%)

## Future Improvements

To add logos for the remaining 167 stocks:
1. Upload `.png` files to the GCS bucket: `gs://shorted-company-logos/logos/`
2. Run `python3 sync-logos.py` to update the database
3. Restart the backend service

## Related Files

- **Sync Script**: `analysis/sync-logos.py`
- **Backend Query**: `services/shorts/internal/store/shorts/postgres.go`
- **Frontend Component**: `web/src/@/components/ui/company-logo.tsx`
- **Database Table**: `company-metadata` (column: `logo_gcs_url`)

