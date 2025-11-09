# Portfolio User ID Fix

## Problem

After fixing the NextAuth JWT callbacks, users were unable to see their portfolio data even though they were logged in.

## Root Cause

The user ID used to key portfolio data in Firebase Firestore changed:

**Before:**

- Portfolio data was stored under the user's email address

**After the JWT fix:**

- User ID was set to Google's `sub` claim (a unique Google identifier like "103847562...")
- This caused the portfolio lookup to fail because it was looking for data under a different key

## Solution

Changed the JWT and session callbacks to **prioritize email as the user ID** instead of the Google `sub` claim:

```typescript
// JWT callback
jwt: async ({ token, user }: { token: JWT; user?: { id?: string; email?: string | null } }) => {
  // Use email as the consistent user ID to maintain compatibility with existing data
  if (user) {
    token.id = user.email ?? user.id ?? token.sub ?? token.email! ?? "unknown";
  }
  return token;
},

// Session callback
session: ({ session, token }) => {
  // Use email as the consistent user ID to maintain compatibility with existing data
  if (token && session.user) {
    session.user.id = token.id ?? session.user.email! ?? token.sub! ?? "unknown";
  }
  return session;
},
```

## User Action Required

**Users need to log out and log back in** for the new user ID logic to take effect. The old JWT token (with the wrong user ID) is cached in the browser cookie.

### Steps to Fix:

1. **Log out** of the application
2. **Clear browser cookies** (optional, but recommended)
3. **Log in again** with Google
4. Portfolio data should now be visible

## Technical Details

### How Portfolio Data is Stored

Portfolio holdings are stored in Firebase Firestore:

- **Collection**: `portfolios`
- **Document ID**: `session.user.id` (now set to email)
- **Data**: Holdings array with stock symbols, shares, and average prices

### ID Priority Order

The user ID is determined with this fallback chain:

1. **user.email** (from OAuth provider) - **PREFERRED**
2. user.id (if set by provider)
3. token.sub (OAuth provider's unique identifier)
4. token.email (from JWT)
5. "unknown" (fallback)

By prioritizing email, we ensure:

- ✅ Consistent user IDs across sessions
- ✅ Compatibility with existing portfolio data
- ✅ Email is stable and doesn't change
- ✅ Works across different auth providers (Google, credentials)

## Alternative: Database Migration

If many users are affected, we could create a migration script to:

1. Query all portfolios with Google `sub` as document ID
2. Look up the user's email from the auth provider
3. Copy the portfolio data to a new document keyed by email
4. Delete the old document

However, since the fix is simple (log out/in), this isn't necessary for now.

## Files Modified

- `web/src/server/auth.ts` - JWT and session callbacks updated

## Prevention

Going forward:

- **Always use email as the primary user identifier** for data storage
- Only use OAuth provider IDs (`sub`) if you have a database adapter that maps them to stable user IDs
- Document any changes to user ID logic clearly to avoid data loss
