# Hybrid SSR + Client-Side Updates Implementation

## Overview

Successfully implemented a hybrid Server-Side Rendering (SSR) pattern for the homepage that combines the benefits of SSR (fast initial load, SEO) with client-side interactivity (dynamic updates without page refresh).

## How It Works

### 1. Initial Server-Side Render

The homepage (`/app/page.tsx`) is a **Server Component** that:

- Fetches initial data on the server using `getTopShortsData()` and `getIndustryTreeMap()`
- Passes this data as props to client components
- Uses ISR with `revalidate = 60` (1 minute cache)

```typescript
// Server Component - runs on server
const Page = async () => {
  const data = await getTopShortsData("3m", 10, 0);
  const treeMapData = await getIndustryTreeMap("3m", 10, ViewMode.CURRENT_CHANGE);

  return (
    <TopShorts
      initialShortsData={data.timeSeries}
      initialPeriod="3m"
    />
    <IndustryTreeMapView
      initialTreeMapData={treeMapData}
      initialPeriod="3m"
      initialViewMode={ViewMode.CURRENT_CHANGE}
    />
  );
};
```

### 2. Client-Side Interactivity

Both `TopShorts` and `IndustryTreeMapView` are **Client Components** that:

- Accept initial SSR data via props
- Display the SSR data immediately (no loading spinner on first render)
- Listen for user interactions (time period changes, view mode changes)
- Make client-side API calls when user changes settings
- Update the UI with new data without page refresh

```typescript
// Client Component - runs on browser
export const TopShorts: FC<TopShortsProps> = ({
  initialShortsData,
  initialPeriod = "3m"
}) => {
  const [period, setPeriod] = useState<string>(initialPeriod);
  const [shortsData, setShortsData] = useState(initialShortsData);

  useEffect(() => {
    // Skip initial mount (we already have SSR data)
    if (firstUpdate.current) {
      firstUpdate.current = false;
      return;
    }

    // Fetch new data when user changes period
    getTopShortsData(period, 10, 0).then(data => {
      setShortsData(data.timeSeries);
    });
  }, [period]);

  // User can change period, triggering client-side fetch
  return <Select onValueChange={setPeriod}>...</Select>;
};
```

## Benefits

### Performance

- **Fast First Paint**: Users see content immediately from SSR
- **No Initial Loading Spinner**: Data is pre-rendered on server
- **Smooth Updates**: Subsequent interactions are client-side only

### SEO

- **Crawlable Content**: Search engines see fully rendered HTML
- **Better Rankings**: Fast load times improve Core Web Vitals
- **Fresh Content**: ISR keeps content up-to-date with 1-minute revalidation

### User Experience

- **Progressive Enhancement**: Works without JavaScript (shows SSR data)
- **Interactive**: Full client-side functionality when JS loads
- **Responsive**: Instant feedback on user interactions

## Key Implementation Details

### 1. Avoiding Double Fetches

Use `useRef` with `firstUpdate` flag to skip the initial `useEffect` run:

```typescript
const firstUpdate = useRef(true);

useEffect(() => {
  if (firstUpdate.current) {
    firstUpdate.current = false;
    return; // Skip initial mount
  }
  // Only fetch on subsequent changes
  fetchData();
}, [period]);
```

### 2. Prop Alignment

Ensure initial props match SSR data to prevent unnecessary re-fetches:

```typescript
// Server: fetches with "3m"
const data = await getTopShortsData("3m", 10, 0);

// Client: defaults to "3m" to match
const [period, setPeriod] = useState<string>(initialPeriod);
```

### 3. Hydration Warning Fix

Add `suppressHydrationWarning` to `<html>` tag to prevent theme-related hydration warnings:

```typescript
<html lang="en" className={fontSans.variable} suppressHydrationWarning>
```

## Files Modified

1. **`/web/src/app/page.tsx`**

   - Removed Suspense boundaries (not needed for client components)
   - Added initial period/viewMode props
   - Cleaned up unused imports

2. **`/web/src/app/topShortsView/topShorts.tsx`**

   - Added `initialPeriod` prop
   - Uses prop value for initial state

3. **`/web/src/app/treemap/treeMap.tsx`**

   - Added `initialPeriod` and `initialViewMode` props
   - Uses prop values for initial state

4. **`/web/src/app/layout.tsx`**

   - Added `suppressHydrationWarning` to fix theme hydration warning

5. **`/web/src/app/stocks/page.tsx`**

   - Fixed debounce ref to use `useRef` instead of `useState`
   - Removed metadata export (can't export from client components)

6. **`/web/src/app/dashboards/page.tsx`**
   - Removed metadata export (can't export from client components)

## Testing

To verify the implementation:

1. **View Page Source**: Should see fully rendered HTML with data
2. **Disable JavaScript**: Should still see initial content
3. **Change Time Period**: Should see loading state and new data without page refresh
4. **Network Tab**: First load has no XHR, subsequent interactions show API calls
5. **Lighthouse**: Should score high on Performance and SEO

## Future Improvements

1. **Add Loading States**: Show skeleton loaders during client-side fetches
2. **Error Handling**: Display user-friendly errors for failed API calls
3. **Optimistic Updates**: Show expected changes before API response
4. **Prefetching**: Preload data for common time period selections
5. **Caching**: Implement client-side cache to avoid redundant API calls

## References

- [Next.js Server Components](https://nextjs.org/docs/app/building-your-application/rendering/server-components)
- [Next.js ISR](https://nextjs.org/docs/app/building-your-application/data-fetching/incremental-static-regeneration)
- [React useEffect Best Practices](https://react.dev/reference/react/useEffect)
