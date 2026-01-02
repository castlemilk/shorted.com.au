# Fix for "Element type is invalid" Error in Development

## Problem

After converting the homepage back to SSR, the page still shows "Element type is invalid" errors when navigating to `/`:

```
[FRONTEND]  ⨯ Internal error: Error: Element type is invalid: expected a string (for built-in components) or a class/function (for composite components) but got: undefined.
[FRONTEND] digest: "386896914"
[FRONTEND]  GET / 500 in 7602ms
```

## Root Cause

**Stale Next.js build cache** - When making significant changes to component exports or switching between client/server components, Next.js's development cache (`.next` directory) can become corrupted and serve outdated module references.

## Solution

### Quick Fix (Recommended)

```bash
cd /Users/benebsworth/projects/shorted/web
rm -rf .next node_modules/.cache
# Restart dev server
```

### Full Nuclear Clean (If Quick Fix Doesn't Work)

```bash
cd /Users/benebsworth/projects/shorted
make dev-stop-services
cd web
rm -rf .next node_modules/.cache
# Optional: Clear node_modules if issue persists
# rm -rf node_modules && npm install
make dev
```

## Why This Happens

1. **Module Hot Reload Conflicts**: When switching between `"use client"` and server components, webpack's hot module replacement can cache outdated module graphs
2. **Import Reference Caching**: Next.js caches import references, so changing from default to named exports (or vice versa) can cause stale references
3. **Webpack Build Cache**: The `.next/cache` directory stores compiled components that may reference deleted or renamed components

## Prevention

### Best Practices:

1. **After Major Refactors**: Always clear `.next` after:

   - Converting client ↔ server components
   - Changing component exports (default ↔ named)
   - Restructuring component directories
   - Updating Next.js or React versions

2. **Use Consistent Export Patterns**:

   ```typescript
   // ✅ Good: Named export (easier to track)
   export function MyComponent() { ... }

   // ✅ Good: Default export with explicit name
   const MyComponent = () => { ... }
   export default MyComponent;

   // ❌ Avoid: Anonymous default exports
   export default () => { ... }
   ```

3. **Clear Cache Command**: Add to `package.json`:
   ```json
   {
     "scripts": {
       "clean": "rm -rf .next node_modules/.cache",
       "dev:clean": "npm run clean && npm run dev"
     }
   }
   ```

## Makefile Command

Add this to your project's Makefile:

```makefile
.PHONY: clean-cache
clean-cache: ## Clear Next.js and webpack caches
	@echo "🧹 Clearing Next.js caches..."
	@cd web && rm -rf .next node_modules/.cache
	@echo "✅ Caches cleared"

.PHONY: dev-clean
dev-clean: clean-cache dev ## Clean caches and start dev server
```

Usage:

```bash
make clean-cache  # Just clear caches
make dev-clean    # Clear caches and restart
```

## Debugging Steps

If errors persist after cache clearing:

### 1. Check Component Exports

```bash
# Find all component exports
grep -r "export.*function\|export default" web/src/app/
```

### 2. Verify Imports Match Exports

```bash
# Check imports in page.tsx
grep "import.*from" web/src/app/page.tsx
```

### 3. Build Production to See Actual Errors

```bash
cd web
npm run build
# Production build shows exact module/component causing issues
```

### 4. Check for Circular Dependencies

```bash
npx madge --circular web/src/app/
```

## Common Causes

| Issue                      | Symptom                             | Fix                                      |
| -------------------------- | ----------------------------------- | ---------------------------------------- |
| **Stale cache**            | "Element type is invalid"           | Clear `.next`                            |
| **Import mismatch**        | "undefined is not a function"       | Check default vs named exports           |
| **Circular dependency**    | Random component undefined          | Use madge to find cycles                 |
| **Client/Server boundary** | "use client" errors                 | Ensure client components properly marked |
| **Protobuf issues**        | "Cannot read property of undefined" | Clear cache + rebuild proto              |

## Test After Fix

```bash
# 1. Clear cache
rm -rf .next node_modules/.cache

# 2. Restart dev server (Ctrl+C first if running)
make dev

# 3. Navigate to homepage
open http://localhost:3020

# Expected: Homepage loads without errors
# GET / 200 in 300-500ms
```

## Success Criteria

✅ Homepage loads without 500 errors  
✅ No "Element type is invalid" in console  
✅ `GET / 200` in server logs  
✅ Components render correctly

## Related Issues

- [Next.js Issue #48748](https://github.com/vercel/next.js/issues/48748) - Cache issues with App Router
- [Next.js Issue #50152](https://github.com/vercel/next.js/issues/50152) - HMR bugs with SSR components
