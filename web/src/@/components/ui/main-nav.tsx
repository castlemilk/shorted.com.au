"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { type NavItem } from "~/@/types/nav";
import { siteConfig } from "~/@/config/site";
import { cn } from "~/@/lib/utils";
import { Icons } from "~/@/components/ui/icons";
import { UserAuthNav } from "~/@/components/ui/user-auth-nav";
import { MobileNav } from "./mobile-nav";

interface MainNavProps {
  items?: NavItem[];
}

export const MainNav = ({ items }: MainNavProps) => {
  const pathname = usePathname();

  return (
    <div className="flex items-center gap-4 md:gap-8 w-full">
      <MobileNav items={items} />
      <Link href="/" className="flex items-center space-x-2 shrink-0 transition-opacity hover:opacity-80">
        <Icons.logo className="h-6 w-6" />
        <span className="inline-block font-bold tracking-tight text-lg">{siteConfig.name}</span>
      </Link>
      {items?.length ? (
        <nav className="hidden md:flex items-center gap-1">
          {items?.map(
            (item: NavItem, index: number) =>
              item.href && (
                <Link
                  key={index}
                  href={item.href}
                  className={cn(
                    "px-3 py-2 rounded-md text-sm font-medium transition-colors",
                    pathname === item.href 
                      ? "bg-secondary text-foreground" 
                      : "text-muted-foreground hover:text-foreground hover:bg-secondary/50",
                    item.disabled && "cursor-not-allowed opacity-80",
                  )}
                >
                  {item.title}
                </Link>
              ),
          )}
        </nav>
      ) : null}
      <div className="ml-auto flex items-center gap-4">
        <UserAuthNav />
      </div>
    </div>
  );
};
