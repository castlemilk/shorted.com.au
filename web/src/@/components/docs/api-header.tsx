"use client";

import React, { useState } from 'react';
import { SearchDialog } from './search-dialog';
import { Button } from '~/@/components/ui/button';
import { Search, Key } from 'lucide-react';
import type { ParsedEndpoint } from '~/lib/openapi/types';
import Link from 'next/link';
import { useSession } from 'next-auth/react';

interface ApiHeaderProps {
  endpoints: ParsedEndpoint[];
}

export function ApiHeader({ endpoints }: ApiHeaderProps) {
  const [open, setOpen] = useState(false);
  const { data: session } = useSession();

  return (
    <>
      <div className="sticky top-0 z-40 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-14 items-center">
          <div className="mr-4 hidden md:flex shrink-0">
            <Link className="mr-6 flex items-center space-x-2" href="/docs/api">
              <span className="hidden font-bold sm:inline-block">
                Shorted API
              </span>
            </Link>
          </div>
          <div className="flex flex-1 items-center justify-between space-x-4 md:justify-end">
            <div className="w-full flex-1 md:w-auto md:flex-none">
              <Button
                variant="outline"
                className="relative h-9 w-full justify-start text-sm text-muted-foreground sm:pr-12 md:w-40 lg:w-64"
                onClick={() => setOpen(true)}
              >
                <Search className="mr-2 h-4 w-4" />
                <span>Search...</span>
                <kbd className="pointer-events-none absolute right-1.5 top-2 hidden h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium opacity-100 sm:flex">
                  <span className="text-xs">⌘</span>K
                </kbd>
              </Button>
            </div>
            {session && (
              <Button variant="ghost" size="sm" asChild className="hidden md:flex gap-2 text-blue-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20">
                <Link href="/docs/api#authentication">
                  <Key className="h-4 w-4" />
                  Mint Token
                </Link>
              </Button>
            )}
          </div>
        </div>
      </div>
      <SearchDialog 
        endpoints={endpoints} 
        open={open} 
        onOpenChange={setOpen} 
      />
    </>
  );
}



