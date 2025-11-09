# NextAuth CSRF Token Fix for Vercel Deployment

## Problem
Vercel deployment was failing with `MissingCSRF` error when users tried to sign in:
```
[auth][error] MissingCSRF: CSRF token was missing during an action signin
```

## Root Cause
NextAuth v5 (Auth.js) beta in serverless environments (Vercel) requires explicit configuration for:
1. Host trust for proxied requests
2. Cookie settings for production
3. Explicit session strategy
4. Proper redirect handling

## Solution

### 1. Updated Auth Configuration (`web/src/server/auth.ts`)

Added explicit configuration for serverless/production environments:

```typescript
export const authOptions = {
  trustHost: true, // Required for Vercel and production environments
  secret: process.env.NEXTAUTH_SECRET,
  session: {
    strategy: "jwt" as const, // Explicit JWT strategy
  },
  cookies: {
    sessionToken: {
      name:
        process.env.NODE_ENV === "production"
          ? "__Secure-next-auth.session-token"
          : "next-auth.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax" as const,
        path: "/",
        secure: process.env.NODE_ENV === "production",
      },
    },
  },
  // ... rest of config
};
```

**Key changes:**
- `trustHost: true` - Allows NextAuth to trust X-Forwarded-Host header from Vercel
- `secret: process.env.NEXTAUTH_SECRET` - Explicit secret configuration
- `session.strategy: "jwt"` - Explicit JWT session strategy
- `cookies.sessionToken` - Production-safe cookie configuration with:
  - `__Secure-` prefix in production
  - `httpOnly: true` for security
  - `sameSite: "lax"` for CSRF protection
  - `secure: true` in production (HTTPS only)

### 2. Fixed Type Safety Issues

**Added proper imports:**
```typescript
import NextAuth, { type Session, type User } from "next-auth";
import type { JWT } from "next-auth/jwt";
import type { AdapterUser } from "next-auth/adapters";
```

**Fixed callback types:**
```typescript
callbacks: {
  async jwt({
    token,
    user,
  }: {
    token: JWT;
    user?: User | AdapterUser; // Proper typing instead of 'any'
  }): Promise<JWT> {
    // On initial sign in, user object is provided
    if (user) {
      // Use email as the consistent user ID to maintain compatibility with existing data
      token.id = user.email ?? user.id ?? token.sub ?? "unknown";
      token.email = user.email ?? token.email;
      token.name = user.name ?? token.name;
      token.picture = user.image ?? token.picture;
      // CRITICAL: Preserve or set sub for middleware checks
      if (!token.sub) {
        token.sub = user.id ?? user.email ?? "unknown";
      }
    }
    
    // Ensure token.id is always set (preserve it on token refresh)
    if (!token.id && token.email) {
      token.id = token.email;
    }
    
    return token;
  },
  async session({
    session,
    token,
  }: {
    session: Session;
    token: JWT;
  }): Promise<Session> {
    if (session.user) {
      session.user.id = token.id ?? session.user.email ?? token.sub ?? "unknown";
    }
    return session;
  },
},
```

### 3. Fixed Sign-In Flow to Use Client-Side NextAuth

**Critical Fix:** Changed from server actions to client-side `signIn()` from `next-auth/react`.

The CSRF error was caused by using server actions (`signInWithGoogle`, `signInWithCredentials`) which don't properly handle CSRF tokens in NextAuth v5 beta on serverless environments.

**Updated `web/src/app/signin/page.tsx`:**

```typescript
import { Suspense } from "react";
import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";

function SignInForm() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/";
  
  // Google OAuth
  const handleGoogleSignIn = async () => {
    await signIn("google", { callbackUrl });
  };

  // Credentials
  const handleCredentialsSignIn = async (e: React.FormEvent) => {
    const result = await signIn("credentials", {
      email,
      password,
      callbackUrl,
      redirect: false,
    });
    
    if (result?.ok) {
      window.location.href = callbackUrl;
    }
  };
  
  // ... form UI ...
}

export default function SignInPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <SignInForm />
    </Suspense>
  );
}
```

**Why this fixes the CSRF error:**
- The client-side `signIn()` function from `next-auth/react` automatically handles CSRF token management
- Server actions don't have access to the proper request context for CSRF validation
- NextAuth v5 beta expects client-side sign-in flow for proper security token handling
- **Suspense boundary required:** `useSearchParams()` in App Router requires a Suspense wrapper to prevent hydration errors

## Required Environment Variables

Ensure these are set in **Vercel** → **Settings** → **Environment Variables**:

1. **`NEXTAUTH_SECRET`** (Required)
   - Generate with: `openssl rand -base64 32`
   - Example: `2lbHaQnG/65RWGE7tvbAz2eka0VI4DlX4buiqHb4nLw=`

2. **`AUTH_GOOGLE_ID`** (For Google OAuth)
   - Your Google OAuth Client ID

3. **`AUTH_GOOGLE_SECRET`** (For Google OAuth)
   - Your Google OAuth Client Secret

4. **`NEXTAUTH_URL`** (Optional but recommended)
   - Production: `https://your-domain.com`
   - Preview: Vercel sets this automatically

## Verification Steps

1. ✅ Build passes locally: `npm run build`
2. ✅ No TypeScript errors
3. ✅ No ESLint errors
4. ✅ Linting passes: `npm run lint`

## Testing in Production

After deploying:

1. Clear browser cookies
2. Navigate to sign-in page
3. Try Google OAuth login
4. Verify successful redirect to home page
5. Check that session persists across page refreshes

## Technical Notes

### Why `trustHost: true`?
Vercel proxies all requests, so the host header differs from the actual request URL. NextAuth needs to trust the `X-Forwarded-Host` header to properly construct callback URLs for OAuth.

### Why explicit cookie configuration?
NextAuth v5 beta in serverless environments doesn't automatically configure cookies for production. Explicit configuration ensures:
- Cookies work across Vercel's edge network
- Proper security settings (httpOnly, secure)
- CSRF protection (sameSite: lax)

### Why `__Secure-` prefix in production?
The `__Secure-` prefix is a browser security feature that ensures cookies are only set over HTTPS, providing additional protection in production.

## Related Files Modified

- `web/src/server/auth.ts` - Main auth configuration with CSRF protection
- `web/src/app/signin/page.tsx` - Sign-in page using client-side NextAuth
- ~~`web/src/app/actions/auth.ts`~~ - Server actions no longer used for auth (kept for backward compatibility)

## References

- [NextAuth.js v5 Beta Docs](https://authjs.dev/)
- [Vercel Environment Variables](https://vercel.com/docs/concepts/projects/environment-variables)
- [NextAuth CSRF Error](https://errors.authjs.dev#missingcsrf)

