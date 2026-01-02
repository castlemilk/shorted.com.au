#!/bin/bash
# =========================================
# Sync Search Index (Algolia)
# =========================================
# 
# This script syncs the Algolia search index with the database.
# It can be run:
#   - Locally after database updates
#   - As a Cloud Run Job triggered after daily sync
#   - As a GitHub Action step
#
# Required environment variables:
#   - DATABASE_URL: PostgreSQL connection string
#   - ALGOLIA_APP_ID: Algolia application ID
#   - ALGOLIA_ADMIN_KEY: Algolia admin API key (write access)
#   - ALGOLIA_INDEX: Index name (default: stocks)
#
# Usage:
#   ./scripts/sync-search-index.sh
#   ./scripts/sync-search-index.sh --dry-run
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
log_error() { echo -e "${RED}❌ $1${NC}"; }

# Parse arguments
DRY_RUN=false
for arg in "$@"; do
    case $arg in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
    esac
done

echo ""
echo "🔍 Algolia Search Index Sync"
echo "============================"
echo ""

# Validate environment
log_info "Validating environment..."

if [ -z "${DATABASE_URL:-}" ]; then
    log_error "DATABASE_URL is required"
    exit 1
fi

if [ -z "${ALGOLIA_APP_ID:-}" ]; then
    log_error "ALGOLIA_APP_ID is required"
    exit 1
fi

if [ -z "${ALGOLIA_ADMIN_KEY:-}" ]; then
    log_error "ALGOLIA_ADMIN_KEY is required"
    exit 1
fi

ALGOLIA_INDEX="${ALGOLIA_INDEX:-stocks}"
log_success "Environment validated"
log_info "  Database: ${DATABASE_URL%%@*}@..."
log_info "  Algolia App: ${ALGOLIA_APP_ID}"
log_info "  Index: ${ALGOLIA_INDEX}"
echo ""

# Check if we're in the right directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

if [ ! -f "$PROJECT_ROOT/web/scripts/sync-algolia.ts" ]; then
    log_error "sync-algolia.ts not found. Are you running from the project root?"
    exit 1
fi

cd "$PROJECT_ROOT/web"

# Check for dependencies
if [ ! -d "node_modules" ]; then
    log_warn "node_modules not found. Installing dependencies..."
    npm ci --legacy-peer-deps
fi

if $DRY_RUN; then
    log_warn "DRY RUN mode - would sync with these settings:"
    log_info "  Records would be fetched from: ${DATABASE_URL%%@*}@..."
    log_info "  Records would be pushed to: ${ALGOLIA_APP_ID}/${ALGOLIA_INDEX}"
    log_success "Dry run complete - no changes made"
    exit 0
fi

# Run the sync
log_info "Starting Algolia sync..."
echo ""

npx tsx scripts/sync-algolia.ts

echo ""
log_success "Algolia sync complete!"

