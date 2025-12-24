"use client";

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Dialog,
  DialogContent,
} from '~/@/components/ui/dialog';
import type { ParsedEndpoint } from '~/lib/openapi/types';
import { Search } from 'lucide-react';
import { cn } from '~/@/lib/utils';

interface SearchDialogProps {
  endpoints: ParsedEndpoint[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SearchDialog({ endpoints, open, onOpenChange }: SearchDialogProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ParsedEndpoint[]>([]);
  const router = useRouter();

  useEffect(() => {
    if (query.trim() === '') {
      setResults([]);
      return;
    }

    const filtered = endpoints.filter((e) =>
      (e.summary?.toLowerCase().includes(query.toLowerCase()) ?? false) ||
      e.path.toLowerCase().includes(query.toLowerCase()) ||
      (e.description?.toLowerCase().includes(query.toLowerCase()) ?? false)
    ).slice(0, 8);

    setResults(filtered);
  }, [query, endpoints]);

  const handleSelect = (id: string) => {
    router.push(`/docs/api/${id}`);
    onOpenChange(false);
    setQuery('');
  };

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(true);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[550px] p-0 gap-0 overflow-hidden">
        <div className="flex items-center border-b px-3">
          <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
          <input
            className="flex h-12 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
            placeholder="Search API documentation..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100">
            <span className="text-xs">ESC</span>
          </kbd>
        </div>
        <div className="max-h-[300px] overflow-y-auto p-2">
          {results.length > 0 ? (
            <div className="space-y-1">
              {results.map((result) => (
                <button
                  key={result.id}
                  className="w-full flex items-center gap-3 px-3 py-2 text-sm rounded-md hover:bg-accent hover:text-accent-foreground text-left transition-colors"
                  onClick={() => handleSelect(result.id)}
                >
                  <div className={cn(
                    "flex items-center justify-center w-8 h-8 rounded border text-[10px] font-bold uppercase shrink-0",
                    result.method === 'GET' && "text-green-500 border-green-500/20 bg-green-500/5",
                    result.method === 'POST' && "text-blue-500 border-blue-500/20 bg-blue-500/5",
                  )}>
                    {result.method}
                  </div>
                  <div className="flex flex-col min-w-0">
                    <span className="font-medium truncate">{result.summary ?? result.path}</span>
                    <span className="text-xs text-muted-foreground truncate">{result.path}</span>
                  </div>
                </button>
              ))}
            </div>
          ) : query ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No results found for "{query}"
            </div>
          ) : (
            <div className="py-6 text-center text-sm text-muted-foreground">
              Type to search endpoints...
            </div>
          )}
        </div>
        <div className="flex items-center justify-end border-t p-2 bg-muted/50">
          <p className="text-[10px] text-muted-foreground">
            Search provided by <span className="font-semibold">Shorted API Search</span>
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}



