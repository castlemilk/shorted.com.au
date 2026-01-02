# React Components

Create React components following Shorted project patterns. Use when building UI components, pages, or features in the Next.js frontend.

## Component Locations

| Type | Location |
|------|----------|
| UI primitives | `web/src/@/components/ui/` |
| Feature components | `web/src/@/components/` |
| Page components | `web/src/app/` |
| Hooks | `web/src/@/hooks/` |

## Instructions

### Component Template

```tsx
"use client"; // Only if needed for interactivity

import { useMemo } from "react";
import { cn } from "@/lib/utils";

interface MyComponentProps {
  data: DataType[];
  variant?: "default" | "compact";
  className?: string;
}

export function MyComponent({
  data,
  variant = "default",
  className,
}: MyComponentProps) {
  // Early return for invalid data
  if (!data || data.length === 0) return null;

  return (
    <div className={cn("base-classes", className)}>
      {/* Implementation */}
    </div>
  );
}
```

### Server Components (Default)

Prefer Server Components for data fetching - no `"use client"` needed:

```tsx
export default async function StockPage({ params }: { params: { code: string } }) {
  const stock = await getStock(params.code);
  return <StockDetails stock={stock} />;
}
```

### Client Data Fetching

Use TanStack Query for client-side data:

```tsx
"use client";

import { useQuery } from "@tanstack/react-query";

export function StockPrice({ code }: { code: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["stock-price", code],
    queryFn: () => fetchStockPrice(code),
  });

  if (isLoading) return <Skeleton className="h-6 w-20" />;
  return <div>${data?.price.toFixed(2)}</div>;
}
```

### Path Aliases

Always use path aliases:

```typescript
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useStockData } from "@/hooks/use-stock-data";
```

### Styling

Use Tailwind with `cn()` for conditional classes:

```tsx
<div className={cn(
  "base-classes",
  isActive && "active-classes",
  className
)} />
```

## Best Practices

- Prefer Server Components over Client Components
- Use TanStack Query for client-side data, not useEffect
- Use Zod for schema validation
- Use descriptive names: `isLoading`, `hasError`, `canSubmit`
- Add JSDoc comments for complex props

