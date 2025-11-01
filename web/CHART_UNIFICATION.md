# Chart Component Unification

## Summary

Created a unified chart component that handles both short position trends and historical stock price data with consistent brush zoom functionality and volume display.

## Changes Made

### 1. New Unified Chart Component

**File**: `web/src/@/components/ui/unified-brush-chart.tsx`

A new flexible chart component that supports:

- **Two data types**:

  - `short-position`: Short position percentage over time
  - `price`: Stock price data (OHLC + Volume)

- **Features**:
  - Brush zoom functionality (on desktop)
  - Volume bars at bottom (for price data)
  - Interactive tooltips showing:
    - Short position: Date + Percentage
    - Price: Date + OHLC + Volume
  - Responsive design (hides brush on mobile)
  - Smooth animations and interactions

### 2. Updated Short Position Chart

**File**: `web/src/@/components/ui/chart.tsx`

- Now uses `UnifiedBrushChart` with `type: "short-position"`
- Converts protobuf `TimeSeriesData` to unified format
- Maintains all existing functionality (period selection, clear/reset)

### 3. Updated Market Price Chart

**File**: `web/src/@/components/ui/market-chart.tsx`

- Now uses `UnifiedBrushChart` with `type: "price"`
- Converts market data to unified format
- Displays volume bars at the bottom
- Shows enhanced tooltip with OHLC data
- Maintains all existing functionality

## Visual Improvements

### Short Position Chart

```
┌─────────────────────────────────────────┐
│  Main Chart: Short Position %          │
│                                         │
│      ╱╲     ╱╲                         │
│     ╱  ╲   ╱  ╲   ╱╲                   │
│    ╱    ╲ ╱    ╲ ╱  ╲                  │
│   ╱      ╲      ╲    ╲                 │
├─────────────────────────────────────────┤
│  Brush/Zoom Control                     │
│  ╭────────────────────────────────╮    │
│  │████████████░░░░░░░░░░░░░░░░░░░│    │
│  ╰────────────────────────────────╯    │
└─────────────────────────────────────────┘
```

### Historical Price Chart

```
┌─────────────────────────────────────────┐
│  Main Chart: Stock Price ($)            │
│                                         │
│      ╱╲     ╱╲                         │
│     ╱  ╲   ╱  ╲   ╱╲                   │
│    ╱    ╲ ╱    ╲ ╱  ╲                  │
│   ╱      ╲      ╲    ╲                 │
├─────────────────────────────────────────┤
│  Volume Bars                            │
│  ┃ ┃┃ ┃┃┃┃  ┃ ┃┃ ┃┃┃                   │
├─────────────────────────────────────────┤
│  Brush/Zoom Control                     │
│  ╭────────────────────────────────╮    │
│  │████████████░░░░░░░░░░░░░░░░░░░│    │
│  ╰────────────────────────────────╯    │
└─────────────────────────────────────────┘
```

## Data Structures

### Short Position Data

```typescript
{
  type: "short-position",
  stockCode: "CBA",
  points: [
    {
      timestamp: Date,
      shortPosition: 0.625 // percentage
    },
    ...
  ]
}
```

### Price Data

```typescript
{
  type: "price",
  stockCode: "CBA",
  points: [
    {
      date: Date,
      open: 167.67,
      high: 169.20,
      low: 167.35,
      close: 168.34,
      volume: 1402351
    },
    ...
  ]
}
```

## Tooltip Enhancements

### Short Position Tooltip

```
┌───────────────┐
│ Oct 31, '25   │
│ 0.625%        │
└───────────────┘
```

### Price Tooltip

```
┌───────────────────┐
│ Oct 31, '25       │
│ $168.34           │
│ O: $167.67 H: $169.20 │
│ L: $167.35 C: $168.34 │
│ Volume: 1,402,351 │
└───────────────────┘
```

## Responsive Behavior

- **Desktop**: Full chart with brush zoom control
- **Mobile**: Main chart only (no brush), optimized height
- **Volume**: Only shown on desktop for price charts

## Benefits

1. **Consistent UX**: Both charts now have the same interaction patterns
2. **Better Data Visualization**: Volume bars provide additional context
3. **Code Reusability**: Single component for multiple use cases
4. **Maintainability**: Easier to update and fix issues
5. **Performance**: Optimized rendering with useMemo and proper data structures

## Testing

To test locally:

1. Navigate to `/shorts/CBA` - Should show short position trends with brush
2. Scroll to "Historical Price Data" - Should show price chart with volume bars and brush
3. Navigate to `/stocks` - Price chart should work there too
4. Test on mobile - Brush should be hidden, charts should be responsive

## Files Changed

- ✅ Created: `web/src/@/components/ui/unified-brush-chart.tsx`
- ✅ Updated: `web/src/@/components/ui/chart.tsx`
- ✅ Updated: `web/src/@/components/ui/market-chart.tsx`
