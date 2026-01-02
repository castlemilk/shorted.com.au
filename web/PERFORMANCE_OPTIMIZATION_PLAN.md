# Performance Optimization Plan

## Current Lighthouse Scores

- **Performance**: 32% ⚠️ (Target: 90%+)
- **Accessibility**: 100% ✅
- **Best Practices**: 100% ✅
- **SEO**: 100% ✅

## Critical Issues Identified

### 1. Core Web Vitals (Critical)
- **First Contentful Paint**: 11% (Target: < 1.8s)
- **Largest Contentful Paint**: 4% (Target: < 2.5s)
- **Total Blocking Time**: 4% (Target: < 200ms)
- **Time to Interactive**: 0% (Target: < 3.8s)

### 2. JavaScript & CSS Issues
- **Unused JavaScript**: 50% (Reduce bundle size)
- **Unused CSS**: 50% (Remove unused styles)
- **Legacy JavaScript**: 50% (Modernize code)
- **Render-blocking resources**: 0% (Defer non-critical CSS/JS)
- **JavaScript execution time**: 0% (Optimize runtime)

### 3. Other Issues
- **Back/forward cache**: 0% (Fix caching headers)
- **Total byte weight**: 50% (Reduce payload size)
- **DOM size**: 50% (Optimize markup)

## Optimization Strategy

### Phase 1: Critical Fixes (Immediate Impact)

#### 1.1 Optimize JavaScript Bundles
**Priority**: 🔴 Critical
**Impact**: High (will improve FCP, LCP, TBT, TTI)

**Actions**:
- [ ] Analyze bundle with `npm run build:analyze`
- [ ] Implement more aggressive code splitting for:
  - `d3` modules (already partially done)
  - `@visx` components (already partially done)
  - Chart libraries
  - Large utility libraries
- [ ] Use dynamic imports for:
  - Chart components (only load when needed)
  - Heavy visualization components
  - Non-critical features
- [ ] Remove unused dependencies
- [ ] Tree-shake unused exports

**Files to modify**:
- `next.config.mjs` - Enhance webpack splitting
- `src/app/page.tsx` - Already using dynamic imports ✅
- `src/app/treemap/treeMap.tsx` - Verify lazy loading
- `src/app/topShortsView/topShorts.tsx` - Add dynamic imports if needed

#### 1.2 Optimize CSS Loading
**Priority**: 🔴 Critical
**Impact**: High (will improve FCP, LCP)

**Actions**:
- [ ] Extract critical CSS for above-the-fold content
- [ ] Defer non-critical CSS loading
- [ ] Remove unused Tailwind classes (use PurgeCSS)
- [ ] Inline critical CSS in `<head>`
- [ ] Load non-critical CSS asynchronously

**Files to modify**:
- `src/app/layout.tsx` - Add critical CSS extraction
- `tailwind.config.ts` - Optimize purge settings
- Create `src/styles/critical.css` for above-fold styles

#### 1.3 Fix Render-Blocking Resources
**Priority**: 🔴 Critical
**Impact**: High (will improve FCP, LCP)

**Actions**:
- [ ] Defer all non-critical JavaScript
- [ ] Use `defer` or `async` for scripts
- [ ] Move analytics to after page load
- [ ] Lazy load third-party scripts (Google Analytics)

**Files to modify**:
- `src/app/layout.tsx` - Optimize script loading
- `src/app/page.tsx` - Defer Google Analytics
- `next.config.mjs` - Configure script optimization

#### 1.4 Optimize Font Loading
**Priority**: 🟡 High
**Impact**: Medium-High (will improve FCP, LCP)

**Actions**:
- [ ] Preload critical fonts
- [ ] Use `font-display: swap` (already done ✅)
- [ ] Subset fonts to only needed characters
- [ ] Consider using system fonts for body text

**Files to modify**:
- `src/app/layout.tsx` - Already optimized ✅
- Add font preloading in `metadata`

### Phase 2: Bundle Optimization (High Impact)

#### 2.1 Reduce JavaScript Bundle Size
**Priority**: 🟡 High
**Impact**: High (will improve TBT, TTI)

**Actions**:
- [ ] Replace heavy libraries with lighter alternatives:
  - Consider alternatives to `d3` for simple visualizations
  - Use lighter chart libraries where possible
- [ ] Implement route-based code splitting
- [ ] Use React.lazy() for component-level splitting
- [ ] Optimize imports (use specific imports, not entire libraries)

**Files to modify**:
- `next.config.mjs` - Enhance splitChunks configuration
- All component files - Optimize imports

#### 2.2 Remove Unused Code
**Priority**: 🟡 High
**Impact**: Medium-High (will reduce bundle size)

**Actions**:
- [ ] Run bundle analyzer to identify unused code
- [ ] Remove unused dependencies
- [ ] Remove unused CSS classes
- [ ] Remove unused components

**Commands**:
```bash
npm run build:analyze
# Review bundle report and remove unused code
```

#### 2.3 Optimize Third-Party Scripts
**Priority**: 🟡 High
**Impact**: Medium (will improve TBT)

**Actions**:
- [ ] Defer Google Analytics loading
- [ ] Use `next/third-parties` optimization (already done ✅)
- [ ] Consider self-hosting analytics
- [ ] Lazy load social media widgets

**Files to modify**:
- `src/app/page.tsx` - Defer Google Analytics

### Phase 3: Runtime Optimization (Medium Impact)

#### 3.1 Reduce Main-Thread Work
**Priority**: 🟡 High
**Impact**: Medium (will improve TBT, TTI)

**Actions**:
- [ ] Break up long-running tasks
- [ ] Use Web Workers for heavy computations
- [ ] Optimize React rendering (use React.memo, useMemo)
- [ ] Debounce/throttle expensive operations
- [ ] Use requestIdleCallback for non-critical work

**Files to modify**:
- `src/app/treemap/treeMap.tsx` - Optimize rendering
- `src/app/topShortsView/topShorts.tsx` - Optimize data processing
- Add Web Workers for heavy calculations

#### 3.2 Optimize Image Loading
**Priority**: 🟢 Medium
**Impact**: Medium (will improve LCP)

**Actions**:
- [ ] Ensure all images use Next.js Image component (already done ✅)
- [ ] Add proper `sizes` attribute (already done ✅)
- [ ] Use `priority` for LCP images
- [ ] Implement lazy loading for below-fold images
- [ ] Convert images to AVIF/WebP (already configured ✅)

**Files to review**:
- All image components - Verify optimization

#### 3.3 Optimize Data Fetching
**Priority**: 🟢 Medium
**Impact**: Medium (will improve TTI)

**Actions**:
- [ ] Implement proper caching strategies
- [ ] Use React Suspense for data fetching
- [ ] Prefetch critical data
- [ ] Optimize API calls

**Files to modify**:
- `src/app/actions/getTopShorts.ts` - Add caching
- `src/app/actions/getIndustryTreeMap.ts` - Add caching

### Phase 4: Caching & Network (Medium Impact)

#### 4.1 Fix Back/Forward Cache
**Priority**: 🟢 Medium
**Impact**: Medium (will improve navigation)

**Actions**:
- [ ] Add proper cache headers
- [ ] Fix unload event listeners
- [ ] Remove beforeunload handlers
- [ ] Ensure pages are cacheable

**Files to modify**:
- `next.config.mjs` - Add cache headers
- Remove problematic event listeners

#### 4.2 Optimize Network Requests
**Priority**: 🟢 Medium
**Impact**: Medium (will reduce total byte weight)

**Actions**:
- [ ] Implement HTTP/2 Server Push for critical resources
- [ ] Use resource hints (preconnect, dns-prefetch) - already done ✅
- [ ] Combine small requests
- [ ] Use CDN for static assets

**Files to modify**:
- `src/app/layout.tsx` - Already has resource hints ✅

### Phase 5: Advanced Optimizations (Low Priority)

#### 5.1 Service Worker & PWA
**Priority**: 🔵 Low
**Impact**: Low-Medium (will improve repeat visits)

**Actions**:
- [ ] Implement service worker for caching
- [ ] Add offline support
- [ ] Implement app shell pattern

#### 5.2 Server-Side Optimizations
**Priority**: 🔵 Low
**Impact**: Low-Medium (will improve initial load)

**Actions**:
- [ ] Optimize server response times
- [ ] Implement edge caching
- [ ] Use ISR (Incremental Static Regeneration) where possible

## Implementation Priority

### Week 1: Critical Fixes
1. Optimize JavaScript bundles (Phase 1.1)
2. Optimize CSS loading (Phase 1.2)
3. Fix render-blocking resources (Phase 1.3)

### Week 2: Bundle Optimization
1. Reduce JavaScript bundle size (Phase 2.1)
2. Remove unused code (Phase 2.2)
3. Optimize third-party scripts (Phase 2.3)

### Week 3: Runtime Optimization
1. Reduce main-thread work (Phase 3.1)
2. Optimize image loading (Phase 3.2)
3. Optimize data fetching (Phase 3.3)

### Week 4: Caching & Polish
1. Fix back/forward cache (Phase 4.1)
2. Optimize network requests (Phase 4.2)
3. Advanced optimizations (Phase 5)

## Success Metrics

### Target Scores
- **Performance**: 90%+ (currently 32%)
- **First Contentful Paint**: < 1.8s
- **Largest Contentful Paint**: < 2.5s
- **Total Blocking Time**: < 200ms
- **Time to Interactive**: < 3.8s
- **Cumulative Layout Shift**: < 0.1

### Measurement
Run Lighthouse after each phase:
```bash
npm run lighthouse
```

## Quick Wins (Can be done immediately)

1. **Defer Google Analytics** - Move to after page load
2. **Extract Critical CSS** - Inline above-fold styles
3. **Add more dynamic imports** - Lazy load charts
4. **Remove unused dependencies** - Clean up package.json
5. **Optimize Tailwind purge** - Remove unused classes

## Notes

- Many optimizations are already in place (dynamic imports, font optimization, image optimization)
- Focus on JavaScript bundle size and render-blocking resources for biggest impact
- Test each change with Lighthouse before moving to next phase
- Monitor bundle size with `npm run build:analyze`

