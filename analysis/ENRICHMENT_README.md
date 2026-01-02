# Company Metadata Enrichment Pipeline

This directory contains the tooling to enrich ASX company metadata using GPT-5 with Deep Research capabilities.

## Overview

The enrichment pipeline:

1. Fetches existing company metadata from Payload CMS
2. Uses GPT-5 to generate comprehensive company profiles
3. Scrapes annual reports from ASX and company websites
4. Validates and cleanses all data
5. Stores enriched metadata in the main Postgres database
6. Provides detailed validation reports

## Files

- `enrich-company-metadata.ipynb` - Main Jupyter notebook with the enrichment pipeline
- `.env.example` - Example environment configuration
- `requirements.txt` - Python dependencies

## Setup

### 1. Install Dependencies

```bash
cd analysis
pip install -r requirements.txt
```

### 2. Configure Environment

Copy `.env.example` to `.env` and update with your credentials:

```bash
cp .env.example .env
```

Key configuration options:

- `OPENAI_API_KEY` - Your OpenAI API key (GPT-5)
- `DATABASE_URL` - Main database connection string
- `CMS_DATABASE_URL` - Payload CMS database connection string
- `PROCESS_SUBSET` - Set to `True` for testing with small subset
- `SUBSET_SIZE` - Number of companies to process in subset mode (default: 10)

### 3. Run Database Migration

Apply the schema changes to your main database:

```bash
cd ../supabase
psql $DATABASE_URL -f migrations/002_enrich_company_metadata.sql
```

## Usage

### Testing with Subset

For initial testing, process a small subset of companies:

1. Ensure `PROCESS_SUBSET=True` in your `.env`
2. Open the notebook: `jupyter notebook enrich-company-metadata.ipynb`
3. Run all cells (Cell → Run All)
4. Review the validation report
5. Check sample enriched records for quality

### Full Dataset Processing

Once satisfied with subset results:

1. Set `PROCESS_SUBSET=False` in `.env`
2. Run the notebook again
3. Monitor progress via checkpoint files
4. Pipeline will resume from last checkpoint if interrupted

### Resuming After Interruption

The pipeline automatically saves progress every 50 companies. If interrupted:

1. Simply re-run the notebook
2. It will automatically resume from the last checkpoint
3. Progress is saved in `data/enrichment_checkpoint.json`

## Output Files

- `data/enriched_metadata_results.csv` - All enriched company data
- `data/enriched_metadata_results_validation_report.json` - Quality metrics
- `data/enrichment_checkpoint.json` - Progress tracking

## Enhanced Schema

The pipeline adds these fields to `company_metadata`:

| Field                    | Type      | Description                             |
| ------------------------ | --------- | --------------------------------------- |
| `tags`                   | TEXT[]    | Specialty tags (e.g., "lithium mining") |
| `enhanced_summary`       | TEXT      | Comprehensive 500-1000 word overview    |
| `company_history`        | TEXT      | Historical timeline and milestones      |
| `key_people`             | JSONB     | Leadership team with bios and LinkedIn  |
| `financial_reports`      | JSONB     | Annual and quarterly report links       |
| `competitive_advantages` | TEXT      | Unique strengths and market position    |
| `risk_factors`           | TEXT      | Key business risks                      |
| `recent_developments`    | TEXT      | News from last 12 months                |
| `social_media_links`     | JSONB     | Twitter, LinkedIn, Facebook URLs        |
| `logo_gcs_url`           | TEXT      | Google Cloud Storage logo URL           |
| `enrichment_status`      | VARCHAR   | Status: pending, completed, failed      |
| `enrichment_date`        | TIMESTAMP | Last enrichment attempt                 |
| `enrichment_error`       | TEXT      | Error message if failed                 |

## Features

### Intelligent Resolvers

The pipeline uses field-specific resolvers to:

- Validate and clean tags
- Structure key people data with LinkedIn profiles
- Combine GPT-5 results with scraped annual reports
- Validate social media URLs

### Annual Report Fetching

Automatically fetches reports from:

- ASX announcements API
- Company investor relations pages
- Validates all URLs before storing

### Error Handling

- Automatic retry with exponential backoff
- Rate limit handling
- Graceful degradation on failures
- Detailed error logging

### Progress Tracking

- Checkpoint-based resumption
- Progress bar for visual feedback
- Statistics on completion rates
- Field coverage analysis

## Validation Reports

After processing, you'll receive:

- **Success Rate**: Percentage of companies successfully enriched
- **Field Coverage**: How many companies have each enriched field
- **Tag Statistics**: Most common tags and unique count
- **Sample Records**: Preview of enriched data

## Cost Management

To manage API costs:

1. Start with `SUBSET_SIZE=10` for testing
2. Increase to 50-100 once confident
3. Monitor OpenAI usage dashboard
4. Adjust `MAX_RETRIES` if seeing frequent failures
5. Use `CHECKPOINT_INTERVAL` to save progress more frequently

## Troubleshooting

### Database Connection Errors

```bash
# Test database connectivity
psql $DATABASE_URL -c "SELECT version();"
psql $CMS_DATABASE_URL -c "SELECT COUNT(*) FROM metadata;"
```

### OpenAI API Errors

- Check API key is valid
- Verify sufficient credits/quota
- Reduce `SUBSET_SIZE` if hitting rate limits
- Increase `RETRY_DELAY` for rate limit errors

### Missing Dependencies

```bash
pip install --upgrade -r requirements.txt
```

### Checkpoint Corruption

If checkpoint file is corrupted:

```bash
rm data/enrichment_checkpoint.json
```

## Best Practices

1. **Start Small**: Always test with subset first
2. **Monitor Costs**: Check OpenAI usage regularly
3. **Validate Quality**: Manually review sample records
4. **Backup Data**: Keep copies of enriched data CSVs
5. **Schedule Runs**: Use cron/scheduler for periodic updates
6. **Version Control**: Track changes to prompts and schema

## Next Steps

After successful enrichment:

1. Review validation reports for quality
2. Spot-check enriched records in database
3. Update web app to display new fields
4. Create company profile pages
5. Implement tag-based search/filtering
6. Schedule periodic re-enrichment for updates

## Support

For issues or questions:

- Check this README first
- Review notebook cell outputs for errors
- Examine validation reports
- Check OpenAI API status
- Review database migration logs

## Updates

To update the pipeline:

1. Pull latest code
2. Review `CHANGELOG.md` for schema changes
3. Run new migrations if required
4. Test with subset before full run
5. Update `.env` with new configuration options
