import { useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export interface StockSearchFilters {
  industry: string | null;
  marketCap: string | null;
  tags: string[];
}

export function useSearchFilters() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [filters, setFilters] = useState<StockSearchFilters>({
    industry: searchParams?.get("industry") ?? null,
    marketCap: searchParams?.get("marketCap") ?? null,
    tags: searchParams?.getAll("tag") ?? [],
  });

  const updateFilter = useCallback(
    (key: keyof StockSearchFilters, value: string | string[] | null) => {
      setFilters((prev) => {
        const newFilters = { ...prev, [key]: value };

        // Update URL
        const params = new URLSearchParams(searchParams?.toString());

        if (value === null || (Array.isArray(value) && value.length === 0)) {
          params.delete(key === "tags" ? "tag" : key);
        } else if (key === "tags" && Array.isArray(value)) {
          params.delete("tag");
          value.forEach((tag) => params.append("tag", tag));
        } else {
          params.set(key, String(value));
        }

        // Use replace to avoid cluttering history
        router.replace(`?${params.toString()}`, { scroll: false });

        return newFilters;
      });
    },
    [router, searchParams],
  );

  const clearFilters = useCallback(() => {
    setFilters({
      industry: null,
      marketCap: null,
      tags: [],
    });
    const params = new URLSearchParams(searchParams?.toString());
    params.delete('industry');
    params.delete('marketCap');
    params.delete('tag');
    router.replace(`?${params.toString()}`, { scroll: false });
  }, [router, searchParams]);

  return {
    filters,
    updateFilter,
    clearFilters,
  };
}

