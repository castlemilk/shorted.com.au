#!/bin/bash
# Continuously run batch enrichment until all stocks have key people populated
# Usage: ./enrich_until_complete.sh [batch_size] [max_iterations]
# Example: ./enrich_until_complete.sh 10 1000

set -e

BATCH_SIZE=${1:-10}
MAX_ITERATIONS=${2:-1000}
SERVICE_URL="https://enrichment-processor-pr-65-234770780438.australia-southeast2.run.app"
DB_URL="${DATABASE_URL:-postgresql://admin:password@localhost:5438/shorts}"

echo "========================================"
echo "Enrichment Until Complete"
echo "========================================"
echo "Batch size: ${BATCH_SIZE}"
echo "Max iterations: ${MAX_ITERATIONS}"
echo "Service: ${SERVICE_URL}"
echo "Started at: $(date)"
echo ""

# Function to get enrichment stats from database
get_db_stats() {
    psql "${DB_URL}" -t -c "
SELECT 
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE COALESCE(enrichment_status, '') = 'completed') AS enriched,
    COUNT(*) FILTER (WHERE COALESCE(enrichment_status, '') NOT IN ('completed', 'failed') OR enrichment_status IS NULL) AS unenriched,
    COUNT(*) FILTER (WHERE key_people IS NOT NULL AND key_people != '[]'::jsonb) AS with_key_people
FROM \"company-metadata\"
" 2>/dev/null | head -1
}

# Function to get stocks needing people backfill
get_people_backfill_count() {
    psql "${DB_URL}" -t -c "
SELECT COUNT(*) 
FROM \"company-metadata\"
WHERE enrichment_status = 'completed'
  AND key_people IS NOT NULL 
  AND key_people != '[]'::jsonb
  AND key_people_enriched_at IS NULL
" 2>/dev/null | head -1 | tr -d ' '
}

# Function to print current status
print_status() {
    local stats=$(get_db_stats)
    local total=$(echo $stats | awk '{print $1}')
    local enriched=$(echo $stats | awk '{print $2}')
    local unenriched=$(echo $stats | awk '{print $3}')
    local with_key_people=$(echo $stats | awk '{print $4}')
    local people_backfill=$(get_people_backfill_count)
    
    echo "----------------------------------------"
    echo "Current Status:"
    echo "  Total stocks:        ${total}"
    echo "  Enriched:            ${enriched}"
    echo "  Unenriched:          ${unenriched}"
    echo "  With key people:     ${with_key_people}"
    echo "  Need people backfill: ${people_backfill:-0}"
    echo "----------------------------------------"
    
    # Return unenriched count for loop control
    echo ${unenriched}
}

# Function to run batch enrichment
run_batch() {
    local iteration=$1
    echo ""
    echo "=== Iteration ${iteration}/${MAX_ITERATIONS} ($(date)) ==="
    echo "Triggering batch of ${BATCH_SIZE} stocks..."
    
    # Call the enrichment service
    local result
    result=$(curl -s --max-time 3600 -X POST "${SERVICE_URL}/enrich-batch?limit=${BATCH_SIZE}&include_stale=true&auto_approve=true&force=false" 2>&1) || {
        echo "ERROR: curl failed: $result"
        return 1
    }
    
    # Check if no stocks need enrichment
    if echo "$result" | grep -q "No stocks need enrichment"; then
        echo "✓ No more stocks need enrichment!"
        return 2
    fi
    
    # Show the result
    echo "$result" | tail -20
    
    return 0
}

# Function to run people backfill
run_people_backfill() {
    local count=$(get_people_backfill_count)
    if [ "${count:-0}" -gt 0 ]; then
        echo ""
        echo "=== Running people backfill for ${count} stocks ==="
        local result
        result=$(curl -s --max-time 3600 -X POST "${SERVICE_URL}/backfill-people?limit=50" 2>&1) || {
            echo "WARNING: People backfill failed: $result"
            return 1
        }
        echo "$result" | tail -10
    fi
}

# Main loop
echo "Initial status:"
remaining=$(print_status)
iteration=0

while [ ${remaining:-9999} -gt 0 ] && [ $iteration -lt $MAX_ITERATIONS ]; do
    iteration=$((iteration + 1))
    
    # Run batch enrichment
    run_batch $iteration
    batch_result=$?
    
    if [ $batch_result -eq 2 ]; then
        # No more stocks need enrichment
        break
    elif [ $batch_result -ne 0 ]; then
        echo "WARNING: Batch failed, continuing..."
    fi
    
    # Show updated status
    remaining=$(print_status)
    
    # Run people backfill if needed
    run_people_backfill
    
    # Brief pause between batches
    if [ ${remaining} -gt 0 ]; then
        echo "Pausing 5 seconds before next batch..."
        sleep 5
    fi
done

# Final status
echo ""
echo "========================================"
echo "FINAL STATUS"
echo "========================================"
print_status

echo ""
if [ ${remaining:-0} -eq 0 ]; then
    echo "✓ SUCCESS: All stocks have been enriched!"
else
    echo "⚠ Stopped: ${remaining} stocks still need enrichment"
fi
echo "Completed at: $(date)"
echo "Total iterations: ${iteration}"
echo "========================================"
