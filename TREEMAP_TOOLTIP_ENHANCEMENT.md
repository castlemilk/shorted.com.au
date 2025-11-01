# Treemap Tooltip Enhancement

## Overview

Enhanced the `industry-treemap-widget.tsx` with a rich, interactive tooltip that loads asynchronously when hovering over stock tiles in the treemap.

## Changes Made

### 1. New Client-Side API Module (`web/src/@/lib/client-api.ts`)

Created a client-side API wrapper for fetching stock data in interactive components:

**Key Features:**

- `fetchStockDetailsClient(productCode)` - Fetches company metadata (logo, name, industry, summary, website)
- `fetchStockDataClient(productCode, period)` - Fetches historical short position time series data
- Non-cached API calls suitable for tooltips and interactive components
- Proper error handling with console logging
- Uses existing Connect-RPC transport

### 2. New TreemapTooltip Component (`web/src/@/components/widgets/treemap-tooltip.tsx`)

A sophisticated tooltip component with async data loading:

**Features:**

- **Async Data Loading**: Fetches stock details and historical data in parallel when hovering
- **Skeleton Loading States**: Shows loading animation while data is being fetched
- **Company Logo**: Displays company logo from GCS URL with fallback to initials
- **Rich Metadata Display**:
  - Product code and company name
  - Current short position percentage
  - Industry classification
  - Company summary (truncated)
  - Website link (clickable)
- **Mini Sparkline Chart**: 30-day trend of short positions with:
  - Green/red color coding based on trend direction
  - Smooth area fill and stroke
  - Compact 288x60px size
- **Change Indicator Badge**: Shows percentage change with up/down arrow
- **Smart Positioning**: Automatically adjusts position based on screen location
- **Responsive Design**: Fixed 320px width with proper spacing and typography

**UI/UX Highlights:**

- Skeleton loading prevents layout shift
- Image error handling with fallback
- Pointer events properly managed (non-blocking)
- Clean, modern design using Tailwind CSS
- Consistent with existing component styling
- Smart positioning that prevents tooltip from going off-screen
- Dynamic placement (left/right/above) based on viewport bounds
- Edge padding ensures tooltip stays within visible area

### 3. Updated Industry Treemap Widget (`web/src/@/components/widgets/industry-treemap-widget.tsx`)

Enhanced the widget to support tooltip interactions:

**Changes:**

- Added `TooltipState` interface to track tooltip data
- Added `tooltipState` useState hook
- Added `onMouseEnter` handler to capture hover events and calculate tooltip position
- Added `onMouseLeave` handler to hide tooltip
- Renders `TreemapTooltip` component when tooltip state is active
- Maintains all existing functionality (click-through, sector grouping, etc.)

### 4. Updated Main Treemap Page (`web/src/app/treemap/treeMap.tsx`)

Enhanced the main treemap page with the same rich tooltip:

**Changes:**

- Replaced simple tooltip state with `tooltipState` matching widget implementation
- Updated `handleMouseEnter` to fetch stock data and pass to tooltip component
- Updated `handleMouseLeave` to clear tooltip state
- Replaced inline tooltip div with `TreemapTooltip` component
- Maintains all existing functionality (view mode, period selection, etc.)

**Technical Implementation:**

- Captures SVG element position using `getBoundingClientRect()`
- Calculates absolute positioning relative to viewport
- Passes stock metadata to tooltip component
- Manages tooltip lifecycle efficiently

## Architecture Decisions

### Why Client-Side API Calls?

- React's `cache()` is designed for server-side rendering
- Tooltips require on-demand, client-side data fetching
- Separate client API prevents cache conflicts
- Better suited for interactive, ephemeral data needs

### Why Async Loading with Skeleton?

- Improves perceived performance
- Better UX than showing stale data or blocking
- Allows users to hover and preview while data loads
- Follows modern web app patterns

### Why Mini Sparkline?

- Provides quick visual context for trends
- Reuses existing `Sparkline` component
- Compact size doesn't overwhelm the tooltip
- Valuable insight into short position momentum

## API Usage

The enhancement leverages these existing APIs:

1. **ShortedStocksService.getStockDetails** - Company metadata
2. **ShortedStocksService.getStockData** - Historical time series data

Both APIs are accessed through Connect-RPC with proper error handling.

## Performance Considerations

- **Parallel Data Fetching**: Both API calls happen simultaneously using `Promise.all()`
- **Debounced Rendering**: React manages component lifecycle efficiently
- **Cleanup Handling**: `useEffect` cleanup prevents memory leaks
- **Image Optimization**: Uses Next.js `Image` component with error handling
- **No Re-fetching**: Data is fetched only once per hover session

## User Experience Improvements

1. **Visual Hierarchy**: Logo, name, and key metrics are prominently displayed
2. **Progressive Disclosure**: Shows skeleton → basic info → full details
3. **Contextual Information**: Industry and summary help users understand the company
4. **Actionable Data**: Website link allows quick navigation
5. **Trend Visibility**: Sparkline shows momentum at a glance
6. **Non-Intrusive**: Tooltip doesn't block interaction with other elements

## Future Enhancements

Potential improvements:

1. Add volume data to tooltip
2. Show comparison to sector average
3. Add watchlist/portfolio quick actions
4. Cache tooltip data in memory to prevent re-fetching
5. Add tooltip animations (fade-in/out)
6. Support keyboard navigation for accessibility
7. Add more detailed price information
8. Show historical high/low short positions

## Testing Recommendations

To test the enhancement:

1. Start the dev environment: `make dev`
2. Navigate to a dashboard with the industry treemap widget
3. Hover over stock tiles to see the tooltip
4. Verify:
   - Skeleton loading appears immediately
   - Company logo loads (or shows fallback)
   - Sparkline renders with correct data
   - Tooltip positioning adjusts based on screen location
   - Clicking still navigates to stock detail page
   - Tooltip disappears on mouse leave

## Compatibility

- ✅ Works with existing widget configuration system
- ✅ Compatible with dashboard layout
- ✅ Supports both sector grouped and flat views
- ✅ No breaking changes to existing components
- ✅ All TypeScript types properly defined
- ✅ No linter errors

## Files Modified/Created

**Created:**

- `web/src/@/lib/client-api.ts` (64 lines)
- `web/src/@/components/widgets/treemap-tooltip.tsx` (187 lines)

**Modified:**

- `web/src/@/components/widgets/industry-treemap-widget.tsx`
  - Added tooltip state management
  - Added hover event handlers
  - Added tooltip rendering
- `web/src/app/treemap/treeMap.tsx`
  - Replaced simple tooltip with rich TreemapTooltip component
  - Updated event handlers to use new tooltip structure
  - Improved tooltip positioning logic

**Dependencies:**

- No new npm packages required
- Reuses existing components: `Skeleton`, `Sparkline`, `Image`
- Leverages existing API infrastructure
