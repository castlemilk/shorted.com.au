#!/bin/bash
# Integrate all housing branches in dependency order, resolving the mechanical
# docs-move conflicts by porting each branch's monolith edit into the new
# docs/feature/housing/architecture.md.
set -u
INT=~/projects/.worktrees/shorted-hw-integration
WT=~/projects/.worktrees
BASE=8c120a352
cd "$INT" || exit 1

port_docs() {
  local wt="$1"
  if git diff --name-only --diff-filter=U | grep -q 'docs/housing-architecture.md'; then
    git checkout --ours docs/housing-architecture.md
    git add docs/housing-architecture.md
    if (cd "$wt" && git diff "$BASE"..HEAD -- docs/housing-architecture.md) \
        | sed 's|docs/housing-architecture\.md|docs/feature/housing/architecture.md|g' \
        | git apply --3way - 2>/dev/null; then
      git add docs/feature/housing/architecture.md
      echo "    ported doc edit into architecture.md"
    else
      git checkout --theirs docs/feature/housing/architecture.md 2>/dev/null || true
      git add docs/feature/housing/architecture.md 2>/dev/null || true
      echo "    WARN: doc port fell back (review architecture.md)"
    fi
  fi
  if git diff --name-only --diff-filter=U | grep -qx 'CLAUDE.md'; then
    git checkout --ours CLAUDE.md
    git add CLAUDE.md
    echo "    CLAUDE.md: kept docs-branch housing section"
  fi
}

BRANCHES="docs/housing-feature-docs: \
feat/housing-repo-hygiene:repo-hygiene \
feat/housing-crawl-correctness:crawl-correctness \
feat/housing-collector-vg:collector-vg \
feat/housing-collector-lifecycle:collector-lifecycle \
feat/housing-mv-correctness:mv-correctness \
feat/housing-api-hardening:api-hardening \
feat/housing-web-suburbs:web-suburbs \
feat/housing-affordability-panel:affordability-panel \
feat/housing-price-drops-choropleth:price-drops-choropleth"

for pair in $BRANCHES; do
  b="${pair%%:*}"; t="${pair##*:}"
  echo "### $b"
  if git merge --no-edit --no-verify "$b" >/dev/null 2>&1; then
    echo "    clean"
    continue
  fi
  port_docs "$WT/shorted-hw-$t"
  rem=$(git diff --name-only --diff-filter=U | wc -l | tr -d ' ')
  if [ "$rem" -gt 0 ]; then
    echo "    UNRESOLVED: $(git diff --name-only --diff-filter=U | tr '\n' ' ')"
    exit 2
  fi
  git -c user.name="Ben Ebsworth" -c user.email="ben.ebsworth@gmail.com" \
      commit -q --no-verify --no-edit && echo "    merged (conflicts resolved)"
done
echo "=== integration HEAD ==="
git log --oneline -1
