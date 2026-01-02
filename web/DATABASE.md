# Database Setup and Management

This document provides comprehensive instructions for setting up and managing the Supabase PostgreSQL database for shorted.com.au.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Initial Setup](#initial-setup)
- [Database Schema](#database-schema)
- [Data Management](#data-management)
- [Maintenance](#maintenance)
- [Troubleshooting](#troubleshooting)

## Prerequisites

### 1. Supabase Account
Create a free account at [supabase.com](https://supabase.com) and create a new project.

### 2. Supabase CLI (Optional for local development)
```bash
# macOS
brew install supabase/tap/supabase

# npm/npx
npx supabase --version

# Other platforms
# See: https://supabase.com/docs/guides/cli
```

### 3. Environment Variables
Copy `.env.local.example` to `.env.local` and add your Supabase credentials:

```bash
# Supabase Configuration
NEXT_PUBLIC_SUPABASE_URL="https://your-project.supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY="your-anon-key"
SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"

# Database URL (from Supabase dashboard > Settings > Database)
DATABASE_URL="postgresql://postgres:[YOUR-PASSWORD]@db.[YOUR-PROJECT-REF].supabase.co:5432/postgres"
```

## Initial Setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Run Database Migrations
Apply the database schema to your Supabase instance:

```bash
# Using the setup script
npm run db:setup

# Or manually via Supabase CLI
supabase db push
```

### 3. Seed Initial Data (Optional)
Load sample data for development/testing:

```bash
npm run db:seed
```

## Database Schema

### Core Tables

#### `shorts`
Daily short position data from ASIC
- `DATE`: Trading date
- `PRODUCT`: Company name
- `PRODUCT_CODE`: Stock ticker (e.g., CBA, BHP)
- `REPORTED_SHORT_POSITIONS`: Number of shares shorted
- `TOTAL_PRODUCT_IN_ISSUE`: Total shares outstanding
- `PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS`: Short percentage

#### `company-metadata`
Company information and details
- `stock_code`: Primary key (ticker symbol)
- `company_name`: Full company name
- `industry`: Industry classification
- `summary`: Brief description
- `website`: Company website
- Additional fields for logos, links, etc.

#### `stock_prices`
Daily stock price data
- `stock_code`: Stock ticker
- `date`: Trading date
- `open`, `high`, `low`, `close`: Price data
- `volume`: Trading volume
- `adjusted_close`: Adjusted closing price

#### `stock_prices_intraday`
Intraday price data (optional)
- Similar to `stock_prices` but with timestamp granularity

#### `subscriptions`
Email notification subscriptions
- `email`: Subscriber email (unique)
- `created_at`: Subscription date

### Support Tables

#### `stock_data_quality`
Data quality tracking for monitoring
- Tracks completeness and anomalies

#### `stock_data_ingestion_log`
ETL process logging
- Tracks data sync operations
- Records success/failure and statistics

### Views

#### `latest_stock_prices`
Most recent price for each stock

#### `stock_price_changes`
Calculated price changes (daily, weekly, monthly)

## Data Management

### Syncing ASIC Data

The application includes scripts to automatically download and sync short position data from ASIC:

```bash
# Sync last 7 days (default)
npm run db:sync-asic

# Sync last 7 days explicitly
npm run db:sync-asic:week

# Sync last 30 days
npm run db:sync-asic:month

# Sync custom number of days
npm run db:sync-asic -- --days 14
```

The sync script:
- Downloads CSV files from ASIC's public data repository
- Parses and validates the data
- Upserts into the database (updates existing, inserts new)
- Logs the operation for monitoring

### Manual Data Operations

#### Using Supabase Dashboard
1. Navigate to your project at [app.supabase.com](https://app.supabase.com)
2. Go to Table Editor
3. Select the table you want to manage
4. Use the GUI to insert, update, or delete records

#### Using SQL Editor
1. In Supabase Dashboard, go to SQL Editor
2. Write and execute SQL queries directly
3. Save frequently used queries as snippets

Example queries:

```sql
-- Get top 10 most shorted stocks today
SELECT 
  "PRODUCT_CODE",
  "PRODUCT",
  "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" as short_pct
FROM shorts
WHERE "DATE" = (SELECT MAX("DATE") FROM shorts)
ORDER BY short_pct DESC
LIMIT 10;

-- Get short position trend for a stock
SELECT 
  "DATE",
  "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" as short_pct
FROM shorts
WHERE "PRODUCT_CODE" = 'CBA'
ORDER BY "DATE" DESC
LIMIT 30;
```

## Maintenance

### Daily Tasks

Run the ASIC sync to get latest data:
```bash
npm run db:sync-asic -- --days 1
```

Consider setting up a cron job or GitHub Action for automatic daily syncs.

### Weekly Tasks

1. Check data quality:
```sql
SELECT * FROM stock_data_quality 
WHERE anomaly_detected = true 
  AND created_at > NOW() - INTERVAL '7 days';
```

2. Review ingestion logs:
```sql
SELECT * FROM stock_data_ingestion_log 
WHERE status = 'failed'
  AND started_at > NOW() - INTERVAL '7 days';
```

### Database Backups

Supabase automatically handles backups for Pro plan and above. For free tier:

```bash
# Export data using pg_dump
pg_dump "$DATABASE_URL" > backup_$(date +%Y%m%d).sql

# Or export specific tables as CSV from Supabase dashboard
```

## Troubleshooting

### Common Issues

#### 1. Connection Refused
- Check if Supabase project is active (free tier pauses after 1 week of inactivity)
- Verify environment variables are set correctly
- Check network/firewall settings

#### 2. Permission Denied
- Ensure you're using the service role key for admin operations
- Check RLS (Row Level Security) policies in Supabase

#### 3. ASIC Data Not Available
- ASIC doesn't publish data on weekends/holidays
- Data is usually available after 9 AM AEST on trading days
- Historical data may be revised, requiring re-sync

#### 4. Duplicate Key Errors
- The sync scripts use UPSERT to handle duplicates
- Check for unique constraints if adding custom data

### Debug Commands

```bash
# Check Supabase status (local)
npm run supabase:status

# Test database connection
node -e "
const { createClient } = require('@supabase/supabase-js');
const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
client.from('shorts').select('count').single().then(console.log).catch(console.error);
"

# View recent logs
supabase db logs
```

### Performance Optimization

1. **Indexes**: All necessary indexes are created in the migration
2. **Materialized Views**: Consider for expensive queries
3. **Connection Pooling**: Supabase handles this automatically
4. **Caching**: Implement application-level caching for frequently accessed data

## Production Deployment

### Pre-deployment Checklist

- [ ] All migrations applied to production database
- [ ] Environment variables set in Vercel/deployment platform
- [ ] Database connection tested
- [ ] Initial data loaded (company metadata)
- [ ] ASIC sync scheduled (cron job or GitHub Actions)
- [ ] Monitoring/alerting configured
- [ ] Backup strategy in place

### Security Considerations

1. **Never commit** service role keys to git
2. Use **environment variables** for all credentials
3. Enable **RLS policies** for public-facing tables
4. Rotate keys periodically
5. Monitor database logs for suspicious activity

## Additional Resources

- [Supabase Documentation](https://supabase.com/docs)
- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [ASIC Short Position Data](https://www.asic.gov.au/regulatory-resources/markets/short-selling/short-position-reports)
- [Project Issues](https://github.com/your-repo/issues)