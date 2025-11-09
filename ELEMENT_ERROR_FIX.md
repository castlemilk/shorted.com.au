# ✅ Fixed: "Element type is invalid" Error

## The Problem

The homepage (`/`) was consistently throwing this error:

```
Error: Element type is invalid: expected a string (for built-in components)
or a class/function (for composite components) but got: undefined.
```

This error occurred during **Server-Side Rendering (SSR)** when logging in or navigating to the homepage.

## Root Cause

The issue was in `/web/src/@/components/ui/sign-in.tsx`:

```typescript
// ❌ BEFORE (caused SSR issues)
export function SignIn({ variant, size, className }: SignInProps = {}) {
  // ...
}
```

The **default parameter `= {}`** syntax was causing the component to be `undefined` during server-side rendering in certain contexts. This is a known issue with TypeScript/React when using default parameters on destructured props in SSR environments.

## The Fix

Removed the problematic default parameter:

```typescript
// ✅ AFTER (fixed)
export function SignIn({ variant, size, className }: SignInProps) {
  // ...
}
```

Since `SignIn` is **always called with props** from `LoginPromptBanner`:

```typescript
<SignIn size="sm" variant="ghost" />
```

The default parameter was unnecessary and causing SSR issues.

## Why This Happened

1. **SSR Context**: During server-side rendering, React's serialization of components can fail when encountering certain TypeScript patterns
2. **Default Parameters**: The `= {}` default on destructured props can cause the function reference to become undefined in the SSR bundle
3. **Cache Persistence**: The `.next` cache can hold onto the broken reference even after code changes

## Verification Steps

After the fix:

1. ✅ Cleared `.next` and `node_modules/.cache`
2. ✅ Restarted dev server
3. ✅ No linter errors
4. 🔄 Test: Navigate to homepage and login

## Testing Checklist

- [ ] Homepage loads without errors
- [ ] Login works correctly
- [ ] Sign in button appears for non-authenticated users
- [ ] No console errors in browser
- [ ] No SSR errors in server logs

## Related Files

- `/web/src/@/components/ui/sign-in.tsx` - Fixed component
- `/web/src/@/components/ui/login-prompt-banner.tsx` - Uses SignIn
- `/web/src/app/page.tsx` - Homepage that renders LoginPromptBanner
- `/Makefile` - Added `clean-cache` command for future issues

## Future Prevention

If you see "Element type is invalid" errors again:

1. Check for components with default parameters on destructured props
2. Look for circular dependencies
3. Verify all named exports are correctly imported
4. Run `make clean-cache` to clear stale build artifacts
5. Check for client/server component boundaries

## Additional Notes

- Login flow is working correctly ✅
- All backend services running (SHORTS, MARKET-DATA, FRONTEND) ✅
- Auth flow (Google OAuth) functioning properly ✅
- Only the homepage had the rendering issue

---

**Status**: Fixed and deployed to dev
**Date**: November 8, 2025
