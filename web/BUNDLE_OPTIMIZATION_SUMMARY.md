# Bundle Optimization Summary

## Overview
This document summarizes the bundle analysis and optimizations performed on the Next.js application.

## Initial Analysis Results

### Before Optimizations
- **Homepage route**: 87.9 kB + 272 kB First Load JS
- **Largest chunks**: 
  - `app/layout.js`: 6.3MB
  - `main.js`: 4.8MB
- **Issues identified**:
  - Full `d3` library imported (instead of specific modules)
  - Unused `recharts` dependency
  - Heavy components loaded synchronously
  - No optimized chunk splitting

## Optimizations Implemented

### 1. Removed Unused Dependencies
- ✅ Removed `recharts` package (not used anywhere in codebase)

### 2. Optimized d3 Imports
- ✅ Replaced `import * as d3 from "d3"` with specific module imports:
  - `d3-selection` for DOM manipulation
  - `d3-hierarchy` for tree layouts
- **Impact**: Reduced bundle size by importing only needed d3 modules instead of entire library

### 3. Dynamic Imports for Heavy Components
- ✅ Added dynamic imports for:
  - `IndustryTreeMapView` component (homepage)
  - `Tree` component (roadmap page)
- **Impact**: These components now load on-demand, reducing initial bundle size

### 4. Enhanced Next.js Configuration

#### Package Import Optimization
Added more `@visx` packages to `optimizePackageImports`:
- `@visx/tooltip`
- `@visx/pattern`
- `@visx/gradient`
- `@visx/event`
- `@visx/vendor`
- `@visx/curve`
- `@visx/responsive`

#### Webpack Chunk Splitting
Implemented optimized chunk splitting strategy:
- **visx chunk**: All `@visx` libraries grouped together (242KB)
- **radix chunk**: All `@radix-ui` components grouped together (142KB)
- **d3 chunk**: All d3 modules grouped together
- **framework chunk**: React/Next.js core libraries (600KB)

**Benefits**:
- Better browser caching (vendor chunks change less frequently)
- Parallel loading of chunks
- Improved code splitting per route

## Results After Optimization

### Route Size Improvements
- **Homepage (`/`)**: 40.9 kB route size (**53% reduction** from 87.9 kB)
- **Roadmap**: 6.83 kB route size
- **Shared chunks**: 184 kB (properly split for better caching)

### Chunk Analysis
```
visx chunk:     242 KB  (all @visx libraries)
radix chunk:     142 KB  (all Radix UI components)
framework chunk: 600 KB  (React/Next.js core)
```

### Key Metrics
- ✅ Homepage route size: **53% reduction**
- ✅ Better code splitting with vendor chunks
- ✅ Improved caching strategy
- ✅ Dynamic loading for heavy components

## Bundle Analyzer

To analyze bundles in the future:
```bash
cd web
ANALYZE=true npm run build
```

Reports are generated in `.next/analyze/`:
- `client.html` - Client-side bundle analysis
- `nodejs.html` - Server-side bundle analysis
- `edge.html` - Edge runtime bundle analysis

## Recommendations for Future Optimizations

1. **Consider removing d3 entirely** if only using d3-selection and d3-hierarchy
2. **Lazy load more components** that are below the fold
3. **Review @visx usage** - consider if all packages are needed or if lighter alternatives exist
4. **Monitor bundle size** regularly using the bundle analyzer
5. **Consider code splitting** for large widget components that aren't always visible

## Files Modified

- `web/src/@/components/tree/tree.tsx` - Optimized d3 imports
- `web/src/app/page.tsx` - Added dynamic import for treemap
- `web/src/app/roadmap/page.tsx` - Added dynamic import for tree component
- `web/next.config.mjs` - Enhanced webpack configuration and package optimizations
- `web/package.json` - Removed recharts, added d3-selection and d3-hierarchy

