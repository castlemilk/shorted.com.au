# ✅ Fixed: Next.js Build Error

## The Problem

Running `make test` was failing during the frontend build phase with:

```
PageNotFoundError: Cannot find module for page: /api/search/stocks
Error: Failed to collect page data for /api/search/stocks
```

This error occurred during Next.js's build-time page data collection.

## Root Cause

**Two issues were found:**

1. **Edge Runtime incompatibility**: The `/api/search/stocks` route was set to use Edge Runtime (`export const runtime = "edge"`), but it was importing the `rateLimit` function, which depends on NextAuth's `auth()` function. NextAuth is **not compatible with Edge Runtime** because it requires Node.js APIs (cookies, headers, etc.).

2. **Incorrect import path**: The `rate-limit.ts` file was importing from `@/auth`, which doesn't exist. The correct import path is `~/server/auth`.

## The Fix

### 1. Removed Edge Runtime from `/api/search/stocks`

```diff
// web/src/app/api/search/stocks/route.ts
- // Use Edge Runtime for faster cold starts
- export const runtime = "edge";
+ // Note: Cannot use Edge Runtime because auth() requires Node.js runtime
```

**Why?** NextAuth's `auth()` function requires Node.js APIs that aren't available in Edge Runtime.

### 2. Fixed import path in `rate-limit.ts`

```diff
// web/src/@/lib/rate-limit.ts
- import { auth } from "@/auth";
+ import { auth } from "~/server/auth";
```

**Why?** The `@/auth` path doesn't exist; the auth configuration is at `~/server/auth`.

## Test Results

After the fix, all tests pass successfully:

```
✅ All tests, linting, and build validation completed successfully!
   🔍 Linting: TypeScript + Go
   🏗️  Build: Frontend (type checking)
   🧪 Unit Tests: Frontend + Backend (144 tests passed)
   🔗 Integration Tests: Backend (all passed)
```

## Files Changed

1. `/web/src/app/api/search/stocks/route.ts` - Removed Edge Runtime export
2. `/web/src/@/lib/rate-limit.ts` - Fixed auth import path

## Key Learnings

- **Edge Runtime limitations**: Edge Runtime doesn't support all Node.js APIs. Features like authentication (NextAuth), file system access, and other Node.js-specific APIs require the standard Node.js runtime.

- **When to use Edge Runtime**: Use Edge Runtime for:

  - Simple API routes without authentication
  - Routes that don't need Node.js APIs
  - Static responses
  - When you need global distribution and faster cold starts

- **When NOT to use Edge Runtime**: Avoid Edge Runtime for:
  - Routes using NextAuth (`auth()`, `signIn()`, `signOut()`)
  - Routes accessing the file system
  - Routes using Node.js-specific APIs
  - Routes using libraries that depend on Node.js runtime

## Related Files

- `/web/src/app/api/health/route.ts` - Can use Edge Runtime (no auth)
- `/web/src/app/api/search/stocks/route.ts` - Cannot use Edge Runtime (uses auth via rate limiting)
- `/web/src/server/auth.ts` - NextAuth configuration (requires Node.js runtime)
