#!/usr/bin/env bash
# Install git hooks for the shorted project.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"

echo "Installing git hooks..."
mkdir -p "$HOOKS_DIR"

cat > "$HOOKS_DIR/pre-commit" <<'HOOK_EOF'
#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
exec "$REPO_ROOT/scripts/local-verify.sh" pre-commit
HOOK_EOF

cat > "$HOOKS_DIR/pre-push" <<'HOOK_EOF'
#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
exec "$REPO_ROOT/scripts/local-verify.sh" pre-push
HOOK_EOF

chmod +x "$HOOKS_DIR/pre-commit" "$HOOKS_DIR/pre-push"

echo "Git hooks installed successfully."
echo ""
echo "Active hooks:"
echo "  - pre-commit: scripts/local-verify.sh pre-commit"
echo "  - pre-push:   scripts/local-verify.sh pre-push"
echo ""
echo "Manual lanes:"
echo "  - npm run verify:fast"
echo "  - npm run verify:full"
echo "  - npm run verify:integration"
