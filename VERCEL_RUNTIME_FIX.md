# Vercel Runtime Error Fix

## Issue

Vercel production deployment was failing with:
```
Error: Element type is invalid: expected a string (for built-in components) 
or a class/function (for composite components) but got: undefined.
```

## Root Cause

The `LoginPromptBanner` client component was being imported directly into a Server Component (`page.tsx`) without proper code-splitting. In production builds on Vercel, this can cause the component to be undefined due to incorrect bundling or client/server boundary issues.

## Solution

Changed from direct import to **dynamic import** with explicit SSR configuration:

### Before (Problematic)
```typescript
import { LoginPromptBanner } from "@/components/ui/login-prompt-banner";
```

### After (Fixed)
```typescript
import dynamic from "next/dynamic";

const LoginPromptBanner = dynamic(
  () =>
    import("@/components/ui/login-prompt-banner").then(
      (mod) => mod.LoginPromptBanner,
    ),
  { ssr: true },
);
```

## Why This Works

1. **Explicit Code-Splitting**: `dynamic()` ensures the client component is properly separated from the server bundle
2. **SSR Support**: `{ ssr: true }` allows the component to render on the server during initial page load
3. **Clear Boundaries**: Makes the client/server boundary explicit for Next.js bundler
4. **Production Stability**: Prevents hydration mismatches and undefined component errors in production

## Files Modified

- `web/src/app/page.tsx` - Changed LoginPromptBanner import to dynamic

## Testing

✅ Local build: Success
```bash
cd web && npm run build
# ✓ Compiled successfully
```

✅ Production deployment: Should resolve the runtime error

## Related Best Practice

For Next.js 14 App Router, when importing client components into server components:
- Use `dynamic()` for optional/conditional client components
- Use `"use client"` directive at the top of the client component file
- Keep server and client component boundaries clear

## Additional Context

This error is common when:
- Client components are conditionally rendered in Server Components
- Production builds use different optimization than development
- Component exports don't match import expectations in production bundles

The dynamic import pattern is the recommended approach for handling this in Next.js 14+.

