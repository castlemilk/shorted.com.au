#!/bin/bash
#
# Sync Enriched Company Metadata from Remote to Local Database
#
# This script:
# 1. Applies migrations to local database
# 2. Syncs enriched company metadata from remote (Supabase) to local (Docker)
# 3. Enables full-stack local development with enriched data
#
# Usage:
#   ./sync-to-local-db.sh [--dry-run] [--limit N]
#

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
LOCAL_DB="postgresql://admin:password@localhost:5438/shorts"
REMOTE_DB="postgresql://postgres.xivfykscsdagwsreyqgf:661wMKAq9zdZpDk2@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres"

# Parse arguments
DRY_RUN=false
LIMIT=""
for arg in "$@"; do
  case $arg in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --limit)
      LIMIT="$2"
      shift 2
      ;;
  esac
done

echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Sync Enriched Data: Remote → Local Database          ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════╝${NC}"
echo ""

# Step 1: Check local database is running
echo -e "${YELLOW}📋 Step 1: Checking local database...${NC}"
if ! docker ps | grep -q postgres; then
    echo -e "${RED}❌ Local PostgreSQL not running${NC}"
    echo -e "${YELLOW}Starting PostgreSQL...${NC}"
    cd analysis/sql && docker compose up -d postgres
    sleep 5
    cd ../..
fi

if docker ps | grep -q postgres; then
    echo -e "${GREEN}✅ Local PostgreSQL is running${NC}"
else
    echo -e "${RED}❌ Failed to start PostgreSQL${NC}"
    exit 1
fi

# Step 2: Test connections
echo -e "\n${YELLOW}📋 Step 2: Testing database connections...${NC}"
if psql "$LOCAL_DB" -c "SELECT 1;" > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Local database connection OK${NC}"
else
    echo -e "${RED}❌ Cannot connect to local database${NC}"
    exit 1
fi

if psql "$REMOTE_DB" -c "SELECT 1;" > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Remote database connection OK${NC}"
else
    echo -e "${RED}❌ Cannot connect to remote database${NC}"
    exit 1
fi

# Step 3: Apply migrations to local database
echo -e "\n${YELLOW}📋 Step 3: Applying migrations to local database...${NC}"

# Check if company-metadata table exists
if psql "$LOCAL_DB" -tc "SELECT 1 FROM information_schema.tables WHERE table_name = 'company-metadata';" | grep -q 1; then
    echo -e "${GREEN}✅ company-metadata table exists${NC}"
else
    echo -e "${YELLOW}⚠️  company-metadata table doesn't exist, creating...${NC}"
    # Apply base migration (if you have one)
fi

# Apply enrichment migrations
echo -e "${YELLOW}Applying migration 002 (enrichment columns)...${NC}"
psql "$LOCAL_DB" -f supabase/migrations/002_enrich_company_metadata.sql 2>&1 | grep -v "already exists" || true

echo -e "${YELLOW}Applying migration 003 (financial statements)...${NC}"
psql "$LOCAL_DB" -f supabase/migrations/003_add_financial_statements.sql 2>&1 | grep -v "already exists" || true

echo -e "${YELLOW}Applying migration 004 (financial report files)...${NC}"
psql "$LOCAL_DB" -f supabase/migrations/004_add_financial_reports_storage.sql 2>&1 | grep -v "already exists" || true

echo -e "${GREEN}✅ Migrations applied${NC}"

# Step 4: Check enriched data in remote
echo -e "\n${YELLOW}📋 Step 4: Checking enriched data in remote database...${NC}"
ENRICHED_COUNT=$(psql "$REMOTE_DB" -t -c "SELECT COUNT(*) FROM \"company-metadata\" WHERE enrichment_status = 'completed';")
ENRICHED_COUNT=$(echo $ENRICHED_COUNT | xargs) # trim whitespace

if [ "$ENRICHED_COUNT" -eq "0" ]; then
    echo -e "${RED}❌ No enriched data found in remote database${NC}"
    echo -e "${YELLOW}Run enrichment pipeline first: cd analysis && python enrich_database.py --limit 10${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Found $ENRICHED_COUNT enriched companies in remote${NC}"

# Step 5: Sync enriched data
echo -e "\n${YELLOW}📋 Step 5: Syncing enriched data...${NC}"

if [ "$DRY_RUN" = true ]; then
    echo -e "${YELLOW}🔍 DRY RUN MODE - No changes will be made${NC}"
    psql "$REMOTE_DB" -c "SELECT stock_code, company_name, enrichment_status, array_length(tags, 1) as tag_count FROM \"company-metadata\" WHERE enrichment_status = 'completed' ORDER BY enrichment_date DESC LIMIT ${LIMIT:-10};"
    exit 0
fi

# Export enriched data from remote
LIMIT_CLAUSE=""
if [ -n "$LIMIT" ]; then
    LIMIT_CLAUSE="LIMIT $LIMIT"
fi

echo -e "${YELLOW}Exporting enriched data from remote...${NC}"
psql "$REMOTE_DB" -c "\COPY (
    SELECT 
        stock_code,
        company_name,
        industry,
        website,
        logo_gcs_url,
        tags,
        enhanced_summary,
        company_history,
        key_people,
        financial_reports,
        competitive_advantages,
        risk_factors,
        recent_developments,
        social_media_links,
        financial_statements,
        enrichment_status,
        enrichment_date,
        enrichment_error
    FROM \"company-metadata\"
    WHERE enrichment_status = 'completed'
    ORDER BY enrichment_date DESC
    $LIMIT_CLAUSE
) TO '/tmp/enriched_data.csv' WITH (FORMAT CSV, HEADER true, NULL '\\N');"

EXPORTED_ROWS=$(wc -l < /tmp/enriched_data.csv)
EXPORTED_ROWS=$((EXPORTED_ROWS - 1)) # subtract header
echo -e "${GREEN}✅ Exported $EXPORTED_ROWS rows to /tmp/enriched_data.csv${NC}"

# Import into local database (upsert pattern)
echo -e "${YELLOW}Importing into local database...${NC}"

# Do everything in one psql session to maintain temp table
psql "$LOCAL_DB" << 'EOSQL'
-- Create and populate temp table for import
CREATE TEMP TABLE IF NOT EXISTS temp_enriched_import (
    stock_code text,
    company_name text,
    industry text,
    website text,
    logo_gcs_url text,
    tags text[],
    enhanced_summary text,
    company_history text,
    key_people jsonb,
    financial_reports jsonb,
    competitive_advantages text,
    risk_factors text,
    recent_developments text,
    social_media_links jsonb,
    financial_statements jsonb,
    enrichment_status varchar(50),
    enrichment_date timestamp with time zone,
    enrichment_error text
);

\COPY temp_enriched_import FROM '/tmp/enriched_data.csv' WITH (FORMAT CSV, HEADER true, NULL '\N');

-- Update existing records
UPDATE "company-metadata" cm
SET
    tags = t.tags,
    enhanced_summary = t.enhanced_summary,
    company_history = t.company_history,
    key_people = t.key_people,
    financial_reports = t.financial_reports,
    competitive_advantages = t.competitive_advantages,
    risk_factors = t.risk_factors,
    recent_developments = t.recent_developments,
    social_media_links = t.social_media_links,
    logo_gcs_url = t.logo_gcs_url,
    financial_statements = t.financial_statements,
    financial_statements_updated_at = CURRENT_TIMESTAMP,
    enrichment_status = t.enrichment_status,
    enrichment_date = t.enrichment_date,
    enrichment_error = t.enrichment_error
FROM temp_enriched_import t
WHERE cm.stock_code = t.stock_code;

-- Insert new records (if any - only columns that exist in both schemas)
INSERT INTO "company-metadata" (
    stock_code,
    company_name,
    industry,
    website,
    logo_gcs_url,
    tags,
    enhanced_summary,
    company_history,
    key_people,
    financial_reports,
    competitive_advantages,
    risk_factors,
    recent_developments,
    social_media_links,
    financial_statements,
    financial_statements_updated_at,
    enrichment_status,
    enrichment_date,
    enrichment_error
)
SELECT
    t.stock_code,
    t.company_name,
    t.industry,
    t.website,
    t.logo_gcs_url,
    t.tags,
    t.enhanced_summary,
    t.company_history,
    t.key_people,
    t.financial_reports,
    t.competitive_advantages,
    t.risk_factors,
    t.recent_developments,
    t.social_media_links,
    t.financial_statements,
    CURRENT_TIMESTAMP,
    t.enrichment_status,
    t.enrichment_date,
    t.enrichment_error
FROM temp_enriched_import t
WHERE NOT EXISTS (
    SELECT 1 FROM "company-metadata" cm WHERE cm.stock_code = t.stock_code
);

DROP TABLE temp_enriched_import;
EOSQL

# Verify import
LOCAL_COUNT=$(psql "$LOCAL_DB" -t -c "SELECT COUNT(*) FROM \"company-metadata\" WHERE enrichment_status = 'completed';")
LOCAL_COUNT=$(echo $LOCAL_COUNT | xargs)

echo -e "${GREEN}✅ Import complete: $LOCAL_COUNT enriched companies in local database${NC}"

# Cleanup
rm -f /tmp/enriched_data.csv

# Step 6: Verify data
echo -e "\n${YELLOW}📋 Step 6: Verifying synced data...${NC}"
psql "$LOCAL_DB" -c "
SELECT 
    stock_code,
    company_name,
    array_length(tags, 1) as tag_count,
    jsonb_array_length(key_people) as people_count,
    jsonb_array_length(financial_reports) as reports_count,
    enrichment_status
FROM \"company-metadata\"
WHERE enrichment_status = 'completed'
ORDER BY enrichment_date DESC
LIMIT 5;
"

# Summary
echo -e "\n${GREEN}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  ✅ Sync Complete!                                     ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════╝${NC}"
echo -e ""
echo -e "${BLUE}📊 Summary:${NC}"
echo -e "  Remote: ${ENRICHED_COUNT} enriched companies"
echo -e "  Local:  ${LOCAL_COUNT} enriched companies"
echo -e "  Synced: ${EXPORTED_ROWS} rows"
echo -e ""
echo -e "${BLUE}🚀 Next steps:${NC}"
echo -e "  1. Update web/.env.local to use local database:"
echo -e "     ${YELLOW}DATABASE_URL=\"postgresql://admin:password@localhost:5438/shorts\"${NC}"
echo -e ""
echo -e "  2. Start the web app:"
echo -e "     ${YELLOW}cd web && npm run dev${NC}"
echo -e ""
echo -e "  3. Visit http://localhost:3020/shorts/WES to see enriched data"
echo -e ""

