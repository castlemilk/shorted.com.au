#!/bin/bash
# Install git hooks for the shorted project
# Run this script after cloning the repository

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"

echo "Installing git hooks..."

# Create pre-commit hook
cat > "$HOOKS_DIR/pre-commit" << 'HOOK_EOF'
#!/bin/bash
# Pre-commit hook for shorted project
# Runs all tests before allowing a commit
# Automatically starts required services (DB + backend) for the frontend build

set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Track background processes for cleanup
BACKEND_PID=""
STARTED_DB=false

cleanup() {
    if [ -n "$BACKEND_PID" ]; then
        echo ""
        echo "Stopping backend service (PID $BACKEND_PID)..."
        kill "$BACKEND_PID" 2>/dev/null || true
        wait "$BACKEND_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# Check if this is a merge commit - skip tests for merge commits
if git rev-parse -q --verify MERGE_HEAD > /dev/null 2>&1; then
    echo "Skipping tests for merge commit"
    exit 0
fi

# Check for rebase
if [ -n "$GIT_REFLOG_ACTION" ] && [ "$GIT_REFLOG_ACTION" = "rebase" ]; then
    echo "Skipping tests during rebase"
    exit 0
fi

echo "Running pre-commit checks..."
echo "   This may take a few minutes..."
echo ""

# --- Ensure backend dependencies are running ---

# 1. Start DB if not already running
if ! pg_isready -h localhost -p 5438 -U admin -q 2>/dev/null; then
    echo "Starting PostgreSQL database..."
    if docker info > /dev/null 2>&1; then
        (cd analysis/sql && docker compose up -d postgres)
        STARTED_DB=true
        # Wait for DB to be ready
        for i in $(seq 1 15); do
            if pg_isready -h localhost -p 5438 -U admin -q 2>/dev/null; then
                echo "Database ready."
                break
            fi
            if [ "$i" = "15" ]; then
                echo "WARNING: Database not ready after 15s, continuing anyway..."
            fi
            sleep 1
        done
    else
        echo "WARNING: Docker not available - database not running"
        echo "   Frontend build may fail if it needs to pre-render pages"
    fi
fi

# 2. Start backend if not already running
if ! curl -sf http://localhost:9091/health > /dev/null 2>&1; then
    echo "Starting shorts backend for frontend build..."
    (
        cd services
        if [ -f .env ]; then
            set -a
            source .env
            set +a
        fi
        export DATABASE_URL="${DATABASE_URL:-postgresql://admin:password@localhost:5438/shorts?sslmode=disable}"
        export GCP_PROJECT_ID="${GCP_PROJECT_ID:-shorted-dev-aba5688f}"
        go run shorts/cmd/server/main.go > /tmp/shorted-pre-commit-backend.log 2>&1
    ) &
    BACKEND_PID=$!

    # Wait for backend health
    echo -n "   Waiting for backend"
    for i in $(seq 1 30); do
        if curl -sf http://localhost:9091/health > /dev/null 2>&1; then
            echo " ready."
            break
        fi
        if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
            echo ""
            echo "ERROR: Backend failed to start. Logs:"
            tail -20 /tmp/shorted-pre-commit-backend.log 2>/dev/null || true
            exit 1
        fi
        if [ "$i" = "30" ]; then
            echo ""
            echo "ERROR: Backend did not become healthy after 30s. Logs:"
            tail -20 /tmp/shorted-pre-commit-backend.log 2>/dev/null || true
            exit 1
        fi
        echo -n "."
        sleep 1
    done
else
    echo "Backend already running on :9091"
fi

echo ""

# --- Run checks ---

echo "Running lint checks..."
if ! make lint; then
    echo ""
    echo "Lint checks failed!"
    exit 1
fi

echo ""
echo "Building frontend..."
if ! make build-frontend; then
    echo ""
    echo "Frontend build failed!"
    exit 1
fi

echo ""
echo "Running unit tests..."
if ! make test-unit; then
    echo ""
    echo "Unit tests failed!"
    exit 1
fi

# Check if Docker is available for integration tests
echo ""
if docker info > /dev/null 2>&1; then
    echo "Docker available - running integration tests..."
    if ! make test-integration; then
        echo ""
        echo "Integration tests failed!"
        exit 1
    fi
else
    echo "WARNING: Docker not available - skipping integration tests"
    echo "   Start Docker Desktop to run integration tests"
fi

echo ""
echo "All pre-commit checks passed!"
echo ""
exit 0
HOOK_EOF

# Make the hook executable
chmod +x "$HOOKS_DIR/pre-commit"

echo "Git hooks installed successfully!"
echo ""
echo "The following hooks are now active:"
echo "  - pre-commit: Runs lint, build, and tests before each commit"
echo "     - Ensures DB + backend are running (starts them if needed)"
echo "     - Lint checks (always run)"
echo "     - Frontend build (always run)"
echo "     - Unit tests (always run)"
echo "     - Integration tests (run if Docker is available)"
echo "     - Cleans up backend on exit if it was started by the hook"
echo ""
echo "To skip the pre-commit hook for a single commit, use:"
echo "  git commit --no-verify"
echo ""
