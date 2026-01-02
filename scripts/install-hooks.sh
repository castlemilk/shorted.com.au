#!/bin/bash
# Install git hooks for the shorted project
# Run this script after cloning the repository

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"

echo "🔧 Installing git hooks..."

# Create pre-commit hook
cat > "$HOOKS_DIR/pre-commit" << 'EOF'
#!/bin/bash
# Pre-commit hook for shorted project
# Runs all tests before allowing a commit

set -e

echo "🔄 Running pre-commit checks..."
echo ""

# Store the current directory
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Check if this is a merge commit - skip tests for merge commits
if git rev-parse -q --verify MERGE_HEAD > /dev/null 2>&1; then
    echo "⏭️  Skipping tests for merge commit"
    exit 0
fi

# Check for rebase
if [ -n "$GIT_REFLOG_ACTION" ] && [ "$GIT_REFLOG_ACTION" = "rebase" ]; then
    echo "⏭️  Skipping tests during rebase"
    exit 0
fi

# Run the full test suite
echo "🧪 Running pre-commit checks..."
echo "   This may take a few minutes..."
echo ""

# Always run lint and build
echo "📋 Running lint checks..."
if ! make lint; then
    echo ""
    echo "❌ Lint checks failed!"
    exit 1
fi

echo ""
echo "🏗️  Building frontend..."
if ! make build-frontend; then
    echo ""
    echo "❌ Frontend build failed!"
    exit 1
fi

echo ""
echo "🧪 Running unit tests..."
if ! make test-unit; then
    echo ""
    echo "❌ Unit tests failed!"
    exit 1
fi

# Check if Docker is available for integration tests
echo ""
if docker info > /dev/null 2>&1; then
    echo "🐳 Docker available - running integration tests..."
    if ! make test-integration; then
        echo ""
        echo "❌ Integration tests failed!"
        exit 1
    fi
else
    echo "⚠️  Docker not available - skipping integration tests"
    echo "   Start Docker Desktop to run integration tests"
fi

echo ""
echo "✅ All pre-commit checks passed!"
echo ""
exit 0
EOF

# Make the hook executable
chmod +x "$HOOKS_DIR/pre-commit"

echo "✅ Git hooks installed successfully!"
echo ""
echo "The following hooks are now active:"
echo "  - pre-commit: Runs lint, build, and tests before each commit"
echo "     - Lint checks (always run)"
echo "     - Frontend build (always run)"
echo "     - Unit tests (always run)"
echo "     - Integration tests (run if Docker is available)"
echo ""
echo "To skip the pre-commit hook for a single commit, use:"
echo "  git commit --no-verify"
echo ""
