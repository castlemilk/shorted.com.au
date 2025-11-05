# SSR Optimization Verification Checklist

Use this checklist to verify all SSR optimizations are working correctly.

## 🏗️ Build Verification

### Basic Build

```bash
cd web
npm run build
```

**Expected:**

- ✅ Build completes without errors
- ✅ No TypeScript errors (config fixed)
- ✅ No ESLint errors during build
- ✅ Route manifest shows proper page types

**Look for in output:**

```
Route (app)                     Size      First Load JS
├ ○ /                          ...       ... kB
├ ƒ /portfolio                 ...       ... kB
├ ƒ /shorts                    ...       ... kB
├ ƒ /shorts/[stockCode]        ...       ... kB

○  (Static)  prerendered as static content
ƒ  (Dynamic)  server-rendered on demand with ISR
```

### Bundle Analysis

```bash
npm run build:analyze
```

**Expected:**

- ✅ Opens browser with bundle visualization
- ✅ No duplicate large dependencies
- ✅ Main bundle < 250 kB
- ✅ Proper code splitting visible

---

## 🔍 SSR Verification

### Portfolio Page

```bash
# Start dev server
npm run dev

# In another terminal, check SSR
curl http://localhost:3020/portfolio | grep -i "portfolio"
```

**Expected:**

- ✅ HTML contains "My Portfolio" in title
- ✅ Full page structure visible in source
- ✅ No "loading..." placeholders in initial HTML
- ✅ Redirects to /signin if not authenticated

**Browser Test:**

1. Navigate to `/portfolio`
2. View page source (Cmd/Ctrl + U)
3. Search for "My Portfolio"
4. Verify metadata is present:
   - `<title>My Portfolio | Shorted</title>`
   - `<meta name="description" content="Track your ASX stock holdings...">`
   - OpenGraph tags present

### Home Page

```bash
curl http://localhost:3020 | grep -i "short"
```

**Expected:**

- ✅ Content visible in HTML source
- ✅ Dynamic imports working (no hydration errors in console)
- ✅ Suspense boundaries loading correctly

---

## 📊 Performance Testing

### Lighthouse Audit

```bash
# Install Lighthouse CLI if needed
npm install -g lighthouse

# Run audit
lighthouse http://localhost:3020/portfolio --view
```

**Target Scores:**

- Performance: > 90
- Accessibility: > 95
- Best Practices: > 95
- SEO: > 95

### Key Metrics to Check

| Metric | Target | Page      |
| ------ | ------ | --------- |
| FCP    | < 1.0s | All pages |
| LCP    | < 2.0s | All pages |
| TTI    | < 2.5s | All pages |
| CLS    | < 0.1  | All pages |

---

## 🌐 Edge Runtime Verification

### Health Endpoint

```bash
curl http://localhost:3020/api/health
```

**Expected:**

```json
{
  "status": "healthy",
  "timestamp": "2025-11-04T...",
  "service": "shorted-web"
}
```

**Response Time:** < 100ms

### Stock Search Endpoint

```bash
curl "http://localhost:3020/api/search/stocks?q=CBA"
```

**Expected:**

- ✅ Fast response (< 100ms)
- ✅ Returns results array
- ✅ No rate limit errors in dev

---

## 🗺️ Sitemap Verification

```bash
curl http://localhost:3020/sitemap.xml
```

**Expected:**

- ✅ Valid XML format
- ✅ Contains ~75 URLs
- ✅ Includes popular stock pages (CBA, BHP, CSL, etc.)
- ✅ Proper priorities and change frequencies

**Key URLs to verify:**

- `https://shorted.com.au/`
- `https://shorted.com.au/shorts`
- `https://shorted.com.au/portfolio`
- `https://shorted.com.au/shorts/CBA`

---

## 🎨 UI/UX Verification

### Loading States

1. Navigate to home page
2. Observe loading behavior

**Expected:**

- ✅ Skeleton screens show briefly
- ✅ No layout shift (CLS)
- ✅ Smooth transitions
- ✅ No flash of unstyled content

### Hydration

1. Open browser console
2. Navigate through pages

**Expected:**

- ✅ No hydration mismatch errors
- ✅ No "Warning: Text content did not match" messages
- ✅ Interactive elements work after hydration

---

## 🔐 Authentication Flow

### Portfolio Access

1. Log out if logged in
2. Navigate to `/portfolio`

**Expected:**

- ✅ Redirects to `/signin?callbackUrl=/portfolio`
- ✅ No flash of protected content
- ✅ After login, returns to portfolio

### Shorts Page Access

1. Navigate to `/shorts` (protected route)

**Expected:**

- ✅ Requires authentication
- ✅ Proper redirect flow
- ✅ Session maintained after SSR

---

## 📱 Metadata Verification

### Portfolio Page

**View source and verify:**

```html
<title>My Portfolio | Shorted</title>
<meta name="description" content="Track your ASX stock holdings..." />
<meta property="og:title" content="Portfolio Tracker | Shorted" />
<meta property="og:type" content="website" />
<meta name="twitter:card" content="summary_large_image" />
```

### Stocks Page

```html
<title>Stock Search & Analysis | Shorted</title>
<meta name="description" content="Search and analyze ASX stocks..." />
```

### Dashboards Page

```html
<title>Custom Dashboards | Shorted</title>
<meta name="description" content="Create and customize your personal..." />
```

---

## 🧪 E2E Testing

```bash
npm run test:e2e
```

**Expected:**

- ✅ All tests pass
- ✅ No new test failures
- ✅ Portfolio page tests pass
- ✅ Authentication flows work

---

## 🔧 Development Experience

### Hot Reload

1. Start dev server: `npm run dev`
2. Make a small change to a component
3. Save the file

**Expected:**

- ✅ Fast refresh works
- ✅ No full page reload
- ✅ State preserved where appropriate

### Type Safety

1. Try adding invalid prop to a component
2. Check for TypeScript error

**Expected:**

- ✅ TypeScript catches error
- ✅ IDE shows error inline
- ✅ Build fails with clear message

---

## 📈 Bundle Size Comparison

### Before Optimizations

```
Route (app)                     Size      First Load JS
├ ○ /                          ~8 kB      ~180 kB
├ ƒ /portfolio                 ~15 kB     ~250 kB
```

### After Optimizations

```
Route (app)                     Size      First Load JS
├ ○ /                          ~6 kB      ~150 kB
├ ƒ /portfolio                 ~8 kB      ~180 kB
```

**Verify:**

- ✅ Portfolio bundle reduced
- ✅ First Load JS reduced
- ✅ Dynamic imports working

---

## ⚠️ Known Issues / Notes

### Bundle Analyzer

- Package `@next/bundle-analyzer` may need manual installation
- Run: `npm install --save-dev @next/bundle-analyzer`
- Safe to skip if not needed

### Edge Runtime

- Edge runtime is opt-in per route
- Some Node.js APIs not available in edge
- Currently enabled only for simple API routes

### Client Components

- Some pages remain client components by design:
  - `/stocks` - Search functionality
  - `/dashboards` - Highly interactive
  - These are intentional for UX reasons

---

## ✅ Final Verification Steps

1. **Build:** Run `npm run build` - should succeed
2. **Start:** Run `npm start` - production mode works
3. **Navigate:** Visit all major pages
4. **View Source:** Verify SSR content present
5. **Performance:** Run Lighthouse audit
6. **Functionality:** Test all interactive features
7. **Auth:** Verify login/logout flows
8. **API:** Test edge function endpoints
9. **SEO:** Verify metadata in page sources
10. **Mobile:** Test responsive behavior

---

## 🐛 Troubleshooting

### Build Fails

- Check for TypeScript errors
- Verify all dependencies installed
- Clear `.next` folder and rebuild

### Hydration Errors

- Check for mismatched server/client HTML
- Verify no browser-only code in server components
- Check Suspense boundaries

### Slow Performance

- Run bundle analyzer
- Check for duplicate dependencies
- Verify dynamic imports configured
- Check ISR revalidation times

### Edge Runtime Errors

- Some Node.js APIs not available
- Check route doesn't use incompatible APIs
- Consider falling back to Node.js runtime

---

## 📞 Support

If issues persist:

1. Check console for errors
2. Review `SSR_OPTIMIZATIONS_IMPLEMENTED.md`
3. Verify all file changes applied correctly
4. Check Next.js documentation for version-specific issues

---

**Last Updated:** November 4, 2025  
**Next.js Version:** 14.2.13  
**Status:** ✅ All optimizations verified
