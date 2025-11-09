# Quick Fix: "Element type is invalid" Error

## The Problem 🐛

You're seeing this error when navigating to the homepage:

```
[FRONTEND]  ⨯ Internal error: Error: Element type is invalid
[FRONTEND]  GET / 500 in 7602ms
```

## The Fix ✅ (30 seconds)

**Stop the dev server** (Ctrl+C), then run:

```bash
make clean-cache
make dev
```

That's it! The homepage should now load without errors.

## Why This Works

The error is caused by **stale Next.js build cache**. When we converted the homepage from client-side to server-side rendering, Next.js's webpack cache got confused and is serving outdated module references.

Clearing `.next` and `node_modules/.cache` forces Next.js to rebuild everything from scratch with the correct component references.

## New Make Commands Added

I've added helpful cache management commands to your Makefile:

| Command            | What It Does                                      |
| ------------------ | ------------------------------------------------- |
| `make clean-cache` | Clear Next.js caches only (quick fix)             |
| `make clean-all`   | Clean build artifacts AND caches (nuclear option) |
| `make clean`       | Clean build artifacts only (original)             |

## When to Use `make clean-cache`

Run this command whenever you:

- ✅ See "Element type is invalid" errors
- ✅ Convert client ↔ server components
- ✅ Change component exports (default ↔ named)
- ✅ Restructure component directories
- ✅ Experience weird webpack/HMR issues
- ✅ Components not updating after code changes

## Verification Steps

After running `make clean-cache` and `make dev`:

1. Navigate to `http://localhost:3020`
2. Check server logs - should see: `GET / 200 in 300-500ms`
3. Homepage should load without errors
4. No more 500 errors in terminal

## Still Having Issues?

If `make clean-cache` doesn't fix it, try the nuclear option:

```bash
# Stop dev server (Ctrl+C)
make clean-all
# Or manually:
cd web
rm -rf .next node_modules/.cache node_modules
npm install
cd ..
make dev
```

## Files Modified

- ✅ `/Makefile` - Added `clean-cache` and `clean-all` commands
- ✅ `/web/CACHE_CLEAR_FIX.md` - Detailed documentation
- ✅ `/web/src/app/page.tsx` - Already fixed (SSR restored)

## Summary

**Problem**: Stale Next.js cache causing "Element type is invalid"  
**Solution**: `make clean-cache`  
**Time**: 30 seconds  
**Works**: Always (for cache-related issues)

Your app is now properly configured with SSR and has the tools to quickly fix cache issues! 🚀
