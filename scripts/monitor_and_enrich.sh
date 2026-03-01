#!/bin/bash
# Monitor enrichment service health and run enrichment when available
# Usage: ./monitor_and_enrich.sh [batch_size] [check_interval_seconds]

set -e

BATCH_SIZE=${1:-10}
CHECK_INTERVAL=${2:-60}
SERVICE_URL="https://enrichment-processor-pr-65-234770780438.australia-southeast2.run.app"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "========================================"
echo "Enrichment Service Monitor"
echo "========================================"
echo "Service URL: ${SERVICE_URL}"
echo "Batch size: ${BATCH_SIZE}"
echo "Check interval: ${CHECK_INTERVAL} seconds"
echo "Started at: $(date)"
echo "========================================"
echo ""

# Function to check service health
check_service_health() {
    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" "${SERVICE_URL}/health" 2>/dev/null || echo "000")
    echo "${status}"
}

# Function to check if DB auth is working
check_db_auth() {
    local result
    result=$(curl -s -X POST "${SERVICE_URL}/enrich-batch?limit=1" 2>&1 || true)
    if echo "${result}" | grep -q "Circuit breaker open"; then
        echo "AUTH_ERROR"
    elif echo "${result}" | grep -q "No stocks need enrichment"; then
        echo "HEALTHY"
    elif echo "${result}" | grep -q "Processing"; then
        echo "HEALTHY"
    else
        echo "UNKNOWN"
    fi
}

# Main loop
attempts=0
while true; do
    attempts=$((attempts + 1))
    
    echo "[$(date)] Check #${attempts}"
    
    # Check HTTP health
    http_status=$(check_service_health)
    
    if [ "${http_status}" != "200" ]; then
        echo "  Service not responding (HTTP ${http_status})"
        echo "  Waiting ${CHECK_INTERVAL} seconds..."
        sleep ${CHECK_INTERVAL}
        continue
    fi
    
    echo "  Service is responding (HTTP 200)"
    
    # Check DB auth
    db_status=$(check_db_auth)
    
    case "${db_status}" in
        "AUTH_ERROR")
            echo "  Database authentication error (circuit breaker open)"
            echo "  Waiting ${CHECK_INTERVAL} seconds..."
            sleep ${CHECK_INTERVAL}
            continue
            ;;
        "HEALTHY")
            echo "  Service is healthy and ready!"
            echo ""
            echo "========================================"
            echo "Starting batch enrichment..."
            echo "========================================"
            
            # Run the enrichment script
            exec "${SCRIPT_DIR}/enrich_until_complete.sh" "${BATCH_SIZE}" 0
            exit 0
            ;;
        *)
            echo "  Unknown service status, checking again..."
            sleep ${CHECK_INTERVAL}
            continue
            ;;
    esac
done
