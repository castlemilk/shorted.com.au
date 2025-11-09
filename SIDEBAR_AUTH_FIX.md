# Sidebar Authentication Fix

## Issue

The dashboard sidebar was showing on public stock detail pages (`/shorts/[stockCode]`) when users were not logged in. This created a confusing UX where unauthenticated users could see navigation links to protected routes (Dashboard, Portfolio, etc.).

## Root Cause

The individual stock detail page (`/shorts/[stockCode]/page.tsx`) is intentionally public for SEO purposes, but it uses `DashboardLayout` which unconditionally renders the `Sidebar` component. The sidebar contained links to protected routes that require authentication.

## Solution

Modified the `Sidebar` component (`web/src/@/components/ui/sidebar.tsx`) to conditionally render based on authentication status:

1. Added `useSession()` hook from `next-auth/react`
2. Return `null` during loading state
3. Return `null` if no session exists (user not authenticated)
4. Only render the sidebar for authenticated users

## Changes Made

### `web/src/@/components/ui/sidebar.tsx`

- Added import: `import { useSession } from "next-auth/react";`
- Added authentication check:

  ```typescript
  const { data: session, status } = useSession();

  // Don't render sidebar if user is not authenticated
  if (status === "loading") {
    return null;
  }

  if (!session) {
    return null; // Don't show sidebar for unauthenticated users
  }
  ```

## Impact

- ✅ Unauthenticated users on public pages (like `/shorts/[stockCode]`) will no longer see the sidebar
- ✅ Authenticated users will continue to see the sidebar on all pages that use `DashboardLayout`
- ✅ Better UX - no confusing navigation links to routes users can't access
- ✅ Maintains SEO-friendly public access to individual stock pages

## Testing

To test this fix:

1. Visit a stock detail page (e.g., `/shorts/BHP`) without being logged in
2. Verify the sidebar is NOT visible
3. Log in and visit the same page
4. Verify the sidebar IS now visible
5. Navigate to protected routes like `/dashboards` or `/portfolio`
6. Verify the sidebar remains visible for authenticated users

## Related Files

- `web/src/@/components/ui/sidebar.tsx` - Modified
- `web/src/@/components/layouts/dashboard-layout.tsx` - Uses Sidebar (unchanged)
- `web/src/app/shorts/[stockCode]/page.tsx` - Public page that uses DashboardLayout (unchanged)
- `web/src/app/layout.tsx` - Contains SessionProvider setup (unchanged)
- `web/src/middleware.ts` - Route protection configuration (unchanged)
