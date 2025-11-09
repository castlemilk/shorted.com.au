# Authentication JWT Fix

## Problem

Users were still seeing the login view on dashboard and portfolio pages even after logging in. The middleware was not recognizing authenticated users.

## Root Cause

The JWT callback in `web/src/server/auth.ts` wasn't ensuring that `token.sub` was always set during token refreshes. The middleware checks for `token?.sub` to validate authentication, but when the token was refreshed (without a `user` object), the `sub` field wasn't being preserved or re-set.

## Solution

Updated the JWT callback in `/web/src/server/auth.ts` to always ensure `token.sub` is set, even during token refreshes:

```typescript
// CRITICAL: Always ensure sub is set - middleware depends on this
// This handles cases where token is refreshed without user object
if (!token.sub && token.email) {
  token.sub = token.email;
}
if (!token.sub && token.id) {
  token.sub = String(token.id);
}
```

## What This Fixes

1. **Middleware Authentication**: The middleware (`web/src/middleware.ts`) checks `token?.sub` to determine if a user is authenticated. Without `sub`, users are redirected to signin even if they have a valid session.

2. **Token Refresh**: When NextAuth refreshes tokens, it doesn't always include the `user` object. The fix ensures `sub` is always present by falling back to `token.email` or `token.id`.

3. **Session Persistence**: Users no longer need to sign in repeatedly - their sessions persist correctly across page navigations and token refreshes.

## How to Test

**Option 1: Sign out and sign back in (Quickest)**

1. Click sign out
2. Sign back in with Google
3. Navigate to dashboard and portfolio - should see content, not login view

**Option 2: Debug Session**
Navigate to `/api/debug-session` to see:

- `hasSub`: Should be `true` if token has sub field
- `hasSession`: Should be `true` if you have a valid session
- `hasToken`: Should be `true` if you have a token

## Files Modified

- `web/src/server/auth.ts` - Added fallback logic to ensure `token.sub` is always set
- `web/src/app/api/debug-session/route.ts` - Created debug endpoint to inspect session state

## Related Issues

This fix ensures compatibility with the middleware authentication checks implemented in `web/src/middleware.ts` which protects routes like:

- `/dashboards`
- `/portfolio`
- `/shorts`
- `/stocks`
