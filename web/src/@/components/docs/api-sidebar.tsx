"use client";

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '~/@/lib/utils';
import { ScrollArea } from '~/@/components/ui/scroll-area';
import type { NavigationGroup } from '~/lib/openapi/types';
import { Shield, Home } from 'lucide-react';

interface ApiSidebarProps {
  groups: NavigationGroup[];
}

export function ApiSidebar({ groups }: ApiSidebarProps) {
  const pathname = usePathname();

  return (
    <ScrollArea className="h-full py-6 pr-6 lg:py-8">
      <div className="w-full space-y-6">
        <div className="pb-4 border-b border-zinc-100 dark:border-zinc-800">
          <h4 className="mb-2 rounded-md px-2 py-1 text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Getting Started
          </h4>
          <div className="grid grid-flow-row auto-rows-max text-sm gap-1">
            <Link
              href="/docs/api"
              className={cn(
                "group flex w-full items-center rounded-md border border-transparent px-2 py-1 hover:underline gap-2",
                pathname === "/docs/api" ? "font-medium text-foreground" : "text-muted-foreground"
              )}
            >
              <Home className="h-4 w-4" />
              Overview
            </Link>
            <Link
              href="/docs/api#authentication"
              className={cn(
                "group flex w-full items-center rounded-md border border-transparent px-2 py-1 hover:underline gap-2",
                pathname === "/docs/api#authentication" ? "font-medium text-foreground" : "text-muted-foreground"
              )}
            >
              <Shield className="h-4 w-4 text-blue-500" />
              Authentication
            </Link>
          </div>
        </div>

        {groups.map((group, index) => (
          <div key={index} className="pb-4">
            <h4 className="mb-1 rounded-md px-2 py-1 text-sm font-semibold">
              {group.title}
            </h4>
            <div className="grid grid-flow-row auto-rows-max text-sm">
              {group.endpoints.map((endpoint, endpointIndex) => {
                const href = `/docs/api/${endpoint.id}`;
                const isActive = pathname === href;

                return (
                  <Link
                    key={endpointIndex}
                    href={href}
                    className={cn(
                      "group flex w-full items-center rounded-md border border-transparent px-2 py-1 hover:underline",
                      isActive
                        ? "font-medium text-foreground"
                        : "text-muted-foreground"
                    )}
                  >
                    <span className={cn(
                      "mr-2 text-[10px] font-bold uppercase",
                      endpoint.method === 'GET' && "text-green-500",
                      endpoint.method === 'POST' && "text-blue-500",
                      endpoint.method === 'PUT' && "text-yellow-500",
                      endpoint.method === 'DELETE' && "text-red-500",
                    )}>
                      {endpoint.method}
                    </span>
                    {endpoint.summary ?? endpoint.path}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}



