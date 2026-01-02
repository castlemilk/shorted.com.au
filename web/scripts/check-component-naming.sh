#!/bin/bash

# Script to check for React component naming issues
# Run this before committing to catch import/export mismatches

set -e

echo "🔍 Checking for React component naming issues..."
echo ""

ISSUES_FOUND=0

# Check 1: Find lowercase default exports that might be components
echo "📋 Checking for lowercase default exports..."
LOWERCASE_EXPORTS=$(find src -name "*.tsx" -type f 2>/dev/null | xargs grep -l "^export default [a-z]" 2>/dev/null | grep -v "page.tsx\|layout.tsx" || true)

if [ -n "$LOWERCASE_EXPORTS" ]; then
  echo "⚠️  Found files with lowercase default exports (might be components):"
  echo "$LOWERCASE_EXPORTS" | while read file; do
    export_name=$(grep "^export default" "$file" | sed 's/export default //' | sed 's/;//' | head -1)
    echo "   - $file: exports '$export_name'"
  done
  echo ""
  ISSUES_FOUND=$((ISSUES_FOUND + 1))
fi

# Check 2: Find const components with lowercase names
echo "📋 Checking for const components with lowercase names..."
LOWERCASE_COMPONENTS=$(find src -name "*.tsx" -type f 2>/dev/null | xargs grep -l "^const [a-z][A-Z].*FC\|^const [a-z][A-Z].*React.FC" 2>/dev/null || true)

if [ -n "$LOWERCASE_COMPONENTS" ]; then
  echo "⚠️  Found components starting with lowercase:"
  echo "$LOWERCASE_COMPONENTS" | while read file; do
    grep "^const [a-z][A-Z]" "$file" | head -3 | while read line; do
      echo "   - $file: $line"
    done
  done
  echo ""
  ISSUES_FOUND=$((ISSUES_FOUND + 1))
fi

# Check 3: TypeScript compilation check
echo "📋 Running TypeScript compiler check..."
if npx tsc --noEmit --pretty 2>&1 | grep -i "cannot find\|is not exported\|has no exported member" > /tmp/tsc_errors.txt 2>&1; then
  echo "⚠️  TypeScript found import/export issues:"
  head -20 /tmp/tsc_errors.txt
  echo ""
  ISSUES_FOUND=$((ISSUES_FOUND + 1))
fi

echo ""
if [ $ISSUES_FOUND -eq 0 ]; then
  echo "✅ No component naming issues found!"
  exit 0
else
  echo "❌ Found $ISSUES_FOUND type(s) of issues. Please review and fix."
  echo ""
  echo "💡 Tips:"
  echo "   - React components must start with uppercase (PascalCase)"
  echo "   - Import names should match export names exactly"
  echo "   - Clear .next cache after fixing: rm -rf .next"
  exit 1
fi

