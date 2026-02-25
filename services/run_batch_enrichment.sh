#!/bin/bash
# Continuously run batch enrichment in batches of N
# Usage: ./run_batch_enrichment.sh [num_batches] [batch_size]
# Example: ./run_batch_enrichment.sh 200 50
set -e

NUM_BATCHES=${1:-200}
BATCH_SIZE=${2:-50}
SERVICE_URL="https://enrichment-processor-pr-65-234770780438.australia-southeast2.run.app"

echo "Starting batch enrichment: up to ${NUM_BATCHES} batches of ${BATCH_SIZE} stocks each"
echo "Service: ${SERVICE_URL}"
echo "Started at: $(date)"
echo ""

total_success=0
total_fail=0
total_skipped=0

for i in $(seq 1 "$NUM_BATCHES"); do
    echo "=== Batch ${i}/${NUM_BATCHES} ($(date)) ==="

    result=$(curl -s --max-time 3600 -X POST "${SERVICE_URL}/enrich-batch?limit=${BATCH_SIZE}&include_stale=true&auto_approve=true&force=true" 2>&1)

    # Check if batch returned "No stocks need enrichment"
    if echo "$result" | grep -q "No stocks need enrichment"; then
        echo "All stocks enriched! Exiting."
        break
    fi

    # Show last few lines (skip per-stock progress for brevity)
    echo "$result" | tail -5

    # Extract numbers from summary line
    summary=$(echo "$result" | grep -E "^Batch enrichment complete:" || echo "")
    if [ -n "$summary" ]; then
        succeeded=$(echo "$summary" | grep -oE '[0-9]+ succeeded' | grep -oE '[0-9]+' || echo "0")
        failed=$(echo "$summary" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+' || echo "0")
        skipped=$(echo "$summary" | grep -oE '[0-9]+ skipped' | grep -oE '[0-9]+' || echo "0")

        total_success=$((total_success + succeeded))
        total_fail=$((total_fail + failed))
        total_skipped=$((total_skipped + skipped))
    fi

    echo "Running total: ${total_success} succeeded, ${total_fail} failed, ${total_skipped} skipped"
    echo ""

    # Brief pause between batches to let the service breathe
    sleep 3
done

echo "=== COMPLETE ==="
echo "Total: ${total_success} succeeded, ${total_fail} failed, ${total_skipped} skipped"
echo "Finished at: $(date)"
