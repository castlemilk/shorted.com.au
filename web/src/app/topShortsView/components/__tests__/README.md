# Sparkline Component Tests

## Overview
These tests prevent regressions in the SparkLine component, particularly around coordinate system issues that can cause tooltip and indicator misalignment.

## Key Regression Tests

### 1. **Coordinate System Protection**
```typescript
it("does not wrap XYChart in extra coordinate-system-breaking elements")
```
**What it prevents**: Wrapping `XYChart` in elements like `<g clipPath>` or other SVG containers that alter the coordinate system. This was the root cause of the tooltip positioning bug where indicators appeared offset from the actual data points.

**Why it matters**: visx's `XYChart` manages its own coordinate transformations using margins. Adding wrapper elements breaks this internal coordinate system, causing tooltips, hover indicators, and mouse events to calculate positions incorrectly.

### 2. **Container Overflow**
```typescript
it("does not have overflow-hidden on relative container")
```
**What it prevents**: Adding `overflow-hidden` to the container that holds the chart.

**Why it matters**: Tooltips need to render outside the chart bounds. With `overflow-hidden`, tooltips get clipped and can't display properly when near edges.

### 3. **Structure Validation**
```typescript
it("renders XYChart with correct structure")
it("renders LineSeries component")
it("renders min and max glyph indicators")
```
**What they prevent**: Accidental removal or misconfiguration of core chart components.

**Why it matters**: Ensures the chart always renders with its line, min/max indicators, and proper SVG structure.

### 4. **Export Validation**
```typescript
it("exports SparkLine as named export")
```
**What it prevents**: Breaking changes to the module's public API.

**Why it matters**: Other components import `{ SparkLine }` from this module. Removing the named export would break imports across the codebase.

## What Caused the Original Bug?

The tooltip positioning issue was caused by:

1. **Wrapping `XYChart` in `<g clipPath>`**: This created a nested coordinate system
2. **Incorrect tooltip positioning**: Mouse events were calculated relative to the wrong parent element
3. **Margin confusion**: visx's internal margins weren't accounted for in the wrapper

The fix was to:
- Remove the `<g clipPath>` wrapper entirely
- Let `XYChart` render directly in the SVG
- Remove `overflow-hidden` from the container
- Keep the component structure simple and flat

## Running the Tests

```bash
# Run sparkline tests only
npm test -- sparkline.test.tsx

# Run with watch mode
npm run test:watch -- sparkline.test.tsx

# Run all tests
npm test
```

## Test Coverage

These tests cover:
- ✅ Component rendering without errors
- ✅ SVG structure and elements
- ✅ Coordinate system integrity
- ✅ Min/max indicator rendering
- ✅ Container positioning and sizing
- ✅ Skeleton loading state
- ✅ Empty data handling
- ✅ Data accessor functionality
- ✅ Export integrity

## Future Improvements

While these tests catch structural issues, they cannot test:
- **Visual positioning accuracy**: Requires visual regression testing (e.g., Playwright, Percy)
- **Interactive behavior**: Mouse hover, tooltip display, click events
- **Cross-browser compatibility**: Rendering differences in different browsers

For more comprehensive testing, consider:
1. **E2E tests** using Playwright to test actual user interactions
2. **Visual regression tests** to catch pixel-level positioning issues
3. **Integration tests** with real data and API responses

