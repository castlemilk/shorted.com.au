# Next Performance Optimizations

Based on Lighthouse analysis, here are the highest-impact optimizations to implement next:

## Priority 1: Critical CSS Extraction (Highest Impact)

### Problem
All CSS is render-blocking, delaying First Contentful Paint.

### Solution
Extract and inline critical CSS for above-the-fold content.

### Implementation
1. Create `src/styles/critical.css` with above-fold styles
2. Inline critical CSS in `layout.tsx` `<head>`
3. Load remaining CSS asynchronously

**Expected Impact**: 
- FCP: -30-40%
- LCP: -20-30%
- Performance Score: +15-20 points

## Priority 2: Remove Unused JavaScript (High Impact)

### Problem
50% unused JavaScript score indicates large bundle with unused code.

### Solution
1. Run bundle analyzer: `npm run build:analyze`
2. Identify and remove unused dependencies
3. Tree-shake unused exports
4. Split code more aggressively

**Expected Impact**:
- Bundle size: -20-30%
- TBT: -25-35%
- Performance Score: +10-15 points

## Priority 3: Optimize Render-Blocking Resources (High Impact)

### Problem
0% score on render-blocking resources audit.

### Solution
1. Defer non-critical CSS
2. Use `preload` for critical resources
3. Optimize script loading order
4. Move inline scripts to bottom

**Expected Impact**:
- FCP: -20-30%
- Performance Score: +10-15 points

## Priority 4: Reduce JavaScript Execution Time (Medium-High Impact)

### Problem
0% score on bootup-time and main-thread work.

### Solution
1. Break up long-running tasks
2. Use Web Workers for heavy computations
3. Optimize React rendering (React.memo, useMemo)
4. Debounce/throttle expensive operations

**Expected Impact**:
- TBT: -30-40%
- TTI: -20-30%
- Performance Score: +8-12 points

## Priority 5: Image Optimization (Medium Impact)

### Problem
50% score on modern image formats (though AVIF/WebP is configured).

### Solution
1. Verify all images use Next.js Image component ✅
2. Add `priority` to LCP images
3. Ensure proper `sizes` attribute ✅
4. Convert remaining images to AVIF/WebP

**Expected Impact**:
- LCP: -15-25%
- Performance Score: +5-8 points

## Implementation Order

1. **Week 1**: Critical CSS + Remove Unused JS
2. **Week 2**: Render-blocking resources + JS execution optimization
3. **Week 3**: Image optimization + Caching improvements

## Success Metrics

Target after all optimizations:
- **Performance Score**: 90%+ (from 32%)
- **FCP**: < 1.8s (from ~3-4s)
- **LCP**: < 2.5s (from ~5-6s)
- **TBT**: < 200ms (from high)
- **TTI**: < 3.8s (from very high)

## Quick Wins Still Available

1. **Remove unused dependencies** - Check package.json
2. **Add React.memo** to expensive components
3. **Preload critical fonts** - Already using font-display: swap ✅
4. **Optimize chart rendering** - Use virtualization for large datasets
5. **Add service worker** - For repeat visit performance

