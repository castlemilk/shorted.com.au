# Vercel Deployment - Auth Issues Checklist

## Symptoms on Vercel
- ✅ Works on localhost
- ❌ Broken on Vercel

## Common NextAuth + Vercel Issues

### 1. Environment Variables ⚠️ CRITICAL

**Required in Vercel:**

```bash
# NextAuth Core
NEXTAUTH_SECRET=<generate with: openssl rand -base64 32>
NEXTAUTH_URL=https://your-domain.vercel.app

# Google OAuth (if using)
AUTH_GOOGLE_ID=your-google-client-id
AUTH_GOOGLE_SECRET=your-google-client-secret

# Database/KV (if using rate limiting)
KV_REST_API_URL=your-upstash-redis-url
KV_REST_API_TOKEN=your-upstash-redis-token
```

**How to check:**
1. Go to Vercel Dashboard → Your Project → Settings → Environment Variables
2. Verify ALL are set for Production
3. **NEXTAUTH_URL MUST match your production domain**

---

### 2. Cookie Domain Issues

**Symptom:** Session works locally but not on Vercel preview deployments

**Cause:** Preview deployments use different domains (e.g., `project-abc123.vercel.app`)

**Solution:** Already set in `auth.ts`:
```typescript
trustHost: true  // ✅ This handles dynamic domains
```

---

### 3. Middleware Edge Runtime Issues

**Check:** Does middleware run on Vercel Edge?

**Verify:**
1. Check build logs for middleware compilation
2. Look for "Middleware" in route compilation output
3. Ensure no Node.js-specific APIs in middleware

**Current middleware.ts location:**
- `/Users/benebsworth/projects/shorted/web/src/middleware.ts`

---

### 4. Session Provider Hydration

**Symptom:** Flash of unauthenticated content or "Login Required" on protected routes

**Check:** Is `layout.tsx` passing session server-side?

**Current implementation:**
```typescript
// layout.tsx
const session = await auth();
return <NextAuthProvider session={session}>...</NextAuthProvider>
```

✅ **This is already implemented**

---

### 5. API Route Base Path

**Symptom:** NextAuth API routes return 404

**Check:**
- NextAuth routes should be at `/api/auth/[...nextauth]`
- **NOT** `/app/api/auth/[...nextauth]`

**Verify in Vercel:**
- Visit: `https://your-domain.vercel.app/api/auth/providers`
- Should return JSON with provider list

---

### 6. Build-Time vs Runtime Issues

**Check Vercel Build Logs:**

```bash
# Look for these in build output:
✓ Generating static pages
✓ Middleware compiled successfully
✓ Route compilation complete
```

**If you see:**
- `Dynamic server usage` warnings → Normal for auth pages
- `Error: Module not found` → Missing dependency or import issue
- `TypeError` during build → Environment variable missing at build time

---

## 🔍 Debugging Steps for Vercel

### Step 1: Check Environment Variables
```bash
# In Vercel Dashboard, verify these are set:
1. NEXTAUTH_SECRET exists
2. NEXTAUTH_URL = "https://your-actual-domain.vercel.app"
3. AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET are set
4. All set for "Production" environment
```

### Step 2: Check Logs
```bash
# In Vercel Dashboard → Deployments → [Your Deploy] → Runtime Logs
# Look for:
- "[SignIn] Auth check result" logs
- NextAuth errors
- 401/403 errors
- Cookie/CORS errors
```

### Step 3: Test Auth Endpoints
```bash
# Open browser console and test:
curl https://your-domain.vercel.app/api/auth/csrf
curl https://your-domain.vercel.app/api/auth/providers
curl https://your-domain.vercel.app/api/auth/session

# Should return JSON, not HTML/404
```

### Step 4: Check Cookies
```bash
# In browser DevTools → Application → Cookies
# Look for: next-auth.session-token or __Secure-next-auth.session-token
# Should have:
- Secure: true (on HTTPS)
- SameSite: Lax
- Domain: your-domain.vercel.app
```

### Step 5: Clear Vercel Cache
```bash
# Sometimes Vercel caches old builds
# Solution: Force new deployment
git commit --allow-empty -m "Force Vercel rebuild"
git push
```

---

## 🚨 Most Common Culprits (80% of issues)

### #1: NEXTAUTH_URL Wrong or Missing
```bash
# ❌ WRONG:
NEXTAUTH_URL=http://localhost:3000

# ✅ CORRECT:
NEXTAUTH_URL=https://shorted.com.au
# OR for preview:
NEXTAUTH_URL=https://preview.shorted.com.au
```

### #2: NEXTAUTH_SECRET Missing
```bash
# Generate new secret:
openssl rand -base64 32

# Add to Vercel env vars
```

### #3: Google OAuth Redirect URI Not Updated
```bash
# In Google Cloud Console, add:
https://your-domain.vercel.app/api/auth/callback/google
```

### #4: Session Cookie Not Being Set
```bash
# Check browser Network tab:
# POST /api/auth/callback/google
# Look for Set-Cookie header
# Should set: __Secure-next-auth.session-token
```

---

## 🧪 Quick Test

Run this in browser console on Vercel deployment:

```javascript
// Test 1: Check if session endpoint works
fetch('/api/auth/session')
  .then(r => r.json())
  .then(data => console.log('Session:', data));

// Test 2: Check providers
fetch('/api/auth/providers')
  .then(r => r.json())
  .then(data => console.log('Providers:', data));

// Test 3: Check CSRF token
fetch('/api/auth/csrf')
  .then(r => r.json())
  .then(data => console.log('CSRF:', data));
```

**Expected output:**
- Session: `{}` or `{user: {...}}`
- Providers: `{google: {...}}`
- CSRF: `{csrfToken: "..."}`

**If you get HTML instead:** API routes are not working

---

## 📝 Report Back

Please provide:
1. **Error message** (from browser console or Vercel logs)
2. **Specific behavior**: What happens when you try to access `/dashboards`?
3. **Environment variables status**: Are NEXTAUTH_URL and NEXTAUTH_SECRET set in Vercel?
4. **Browser console logs**: Any errors or warnings?
5. **Network tab**: Does `/api/auth/session` return JSON?

This will help pinpoint the exact issue!

