---
name: react-components
description: Create React components following Shorted project patterns. Use when building UI components, pages, or features in the Next.js frontend.
allowed-tools: Read, Write, Grep, Glob
---

# Creating React Components

This skill guides you through creating React components that follow Shorted project conventions.

## Component Locations

| Type | Location | When to Use |
|------|----------|-------------|
| UI primitives | `web/src/@/components/ui/` | Buttons, inputs, cards, etc. |
| Feature components | `web/src/@/components/` | Stock charts, search, company info |
| Page components | `web/src/app/` | Route-specific pages |
| Hooks | `web/src/@/hooks/` | Reusable stateful logic |

## Component Template

```tsx
"use client"; // Only add if component needs interactivity

import { useMemo, useCallback } from "react";
import { cn } from "@/lib/utils";

// 1. Types/Interfaces
interface MyComponentProps {
  /** Description of the prop */
  data: DataType[];
  /** Optional prop with default */
  variant?: "default" | "compact";
  /** Callback when something happens */
  onSelect?: (item: DataType) => void;
  /** Additional CSS classes */
  className?: string;
}

// 2. Constants
const VARIANTS = {
  default: "p-4 rounded-lg",
  compact: "p-2 rounded",
} as const;

// 3. Main Component Export
export function MyComponent({
  data,
  variant = "default",
  onSelect,
  className,
}: MyComponentProps) {
  // Early return for invalid data
  if (!data || data.length === 0) {
    return null;
  }

  // Memoize expensive computations
  const processedData = useMemo(() => {
    return data.map((item) => ({
      ...item,
      formatted: formatValue(item.value),
    }));
  }, [data]);

  // Memoize callbacks
  const handleClick = useCallback(
    (item: DataType) => {
      onSelect?.(item);
    },
    [onSelect]
  );

  return (
    <div className={cn(VARIANTS[variant], className)}>
      {processedData.map((item) => (
        <ItemRow key={item.id} item={item} onClick={handleClick} />
      ))}
    </div>
  );
}

// 4. Sub-components (keep in same file if small)
interface ItemRowProps {
  item: ProcessedDataType;
  onClick: (item: DataType) => void;
}

function ItemRow({ item, onClick }: ItemRowProps) {
  return (
    <button
      onClick={() => onClick(item)}
      className="flex items-center gap-2 hover:bg-muted/50 transition-colors"
    >
      <span>{item.formatted}</span>
    </button>
  );
}

// 5. Helper functions
function formatValue(value: number): string {
  return value.toLocaleString("en-AU", {
    style: "currency",
    currency: "AUD",
  });
}
```

## Server Components (Default)

Prefer Server Components for data fetching. No `"use client"` directive needed:

```tsx
// web/src/app/stocks/[code]/page.tsx
import { getStock } from "@/lib/api";
import { StockDetails } from "@/components/company/stock-details";

interface PageProps {
  params: { code: string };
}

export default async function StockPage({ params }: PageProps) {
  const stock = await getStock(params.code);

  if (!stock) {
    return <NotFound message={`Stock ${params.code} not found`} />;
  }

  return (
    <main className="container mx-auto py-8">
      <StockDetails stock={stock} />
    </main>
  );
}

// Generate metadata for SEO
export async function generateMetadata({ params }: PageProps) {
  const stock = await getStock(params.code);
  return {
    title: stock?.name ?? params.code,
    description: `Short selling data for ${stock?.name}`,
  };
}
```

## Client Components with Data Fetching

Use TanStack Query for client-side data:

```tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";

interface StockPriceProps {
  code: string;
}

export function StockPrice({ code }: StockPriceProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["stock-price", code],
    queryFn: () => fetchStockPrice(code),
    staleTime: 60 * 1000, // 1 minute
    refetchInterval: 5 * 60 * 1000, // 5 minutes
  });

  if (isLoading) {
    return <Skeleton className="h-6 w-20" />;
  }

  if (error) {
    return <span className="text-destructive">Error loading price</span>;
  }

  const isPositive = data.change >= 0;

  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-lg">${data.price.toFixed(2)}</span>
      <span
        className={cn(
          "text-sm",
          isPositive ? "text-emerald-500" : "text-red-500"
        )}
      >
        {isPositive ? "+" : ""}
        {data.change.toFixed(2)}%
      </span>
    </div>
  );
}
```

## Using Connect-RPC with React Query

```tsx
"use client";

import { useQuery } from "@connectrpc/connect-query";
import { getTopShorts } from "~/gen/shorts/v1alpha1/shorts-ShortedStocksService_connectquery";

export function TopShortsList() {
  const { data, isLoading } = useQuery(getTopShorts, {
    period: "1m",
    limit: 10,
  });

  if (isLoading) return <LoadingSkeleton />;

  return (
    <ul>
      {data?.stocks.map((stock) => (
        <li key={stock.productCode}>{stock.name}</li>
      ))}
    </ul>
  );
}
```

## Path Aliases

Always use path aliases:

```typescript
// ✅ Good
import { Button } from "@/components/ui/button";
import { useStockData } from "@/hooks/use-stock-data";
import { cn } from "@/lib/utils";
import { StockPage } from "~/app/stocks/[code]/page";

// ❌ Bad
import { Button } from "../../../@/components/ui/button";
```

## Styling with Tailwind

Use Tailwind classes and the `cn()` utility for conditional classes:

```tsx
import { cn } from "@/lib/utils";

interface BadgeProps {
  variant: "positive" | "negative" | "neutral";
  children: React.ReactNode;
}

export function Badge({ variant, children }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-1 text-xs font-medium",
        {
          "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200":
            variant === "positive",
          "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200":
            variant === "negative",
          "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200":
            variant === "neutral",
        }
      )}
    >
      {children}
    </span>
  );
}
```

## Testing Components

```tsx
// web/src/@/components/ui/__tests__/badge.test.tsx
import { render, screen } from "@testing-library/react";
import { Badge } from "../badge";

describe("Badge", () => {
  it("renders positive variant correctly", () => {
    render(<Badge variant="positive">+5.2%</Badge>);
    expect(screen.getByText("+5.2%")).toHaveClass("bg-emerald-100");
  });

  it("renders negative variant correctly", () => {
    render(<Badge variant="negative">-3.1%</Badge>);
    expect(screen.getByText("-3.1%")).toHaveClass("bg-red-100");
  });
});
```

Run tests:

```bash
make test-frontend
```

