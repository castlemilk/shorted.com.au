#!/bin/bash
# Daily newsroom draft run — generates draft takes for morning review.
# Install (crontab -e):  30 7 * * 1-5  /Users/benebsworth/projects/shorted/scripts/take-writer/bin/newsroom-cron.sh >> $HOME/Library/Logs/shorted-newsroom.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export GEMINI_API_KEY=$(grep '^GEMINI_API_KEY' ../../.env | cut -d= -f2)
export DATABASE_URL=$(gcloud secrets versions access latest --secret=DATABASE_URL --project=rosy-clover-477102-t5 --account=ben@shorted.com.au)
echo "=== newsroom-daily $(date -Iseconds) ==="
npx tsx src/index.ts newsroom-daily --top=3
echo "=== drafts ready — review with: npx tsx src/index.ts list-drafts ==="
