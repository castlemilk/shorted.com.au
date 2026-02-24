"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Lock } from "lucide-react";
import { useSession } from "next-auth/react";

import { type NavItem } from "~/@/types/nav";
import { siteConfig } from "~/@/config/site";
import { cn } from "~/@/lib/utils";
import { Icons } from "~/@/components/ui/icons";
import { UserAuthNav } from "~/@/components/ui/user-auth-nav";
import { NavSearchInput } from "~/@/components/ui/nav-search-input";
import { MobileNav } from "./mobile-nav";

interface MainNavProps {
  items?: NavItem[];
  modeToggle?: React.ReactNode;
}

export const MainNav = ({ items, modeToggle }: MainNavProps) => {
  const pathname = usePathname();
  const { data: session } = useSession();

  return (
    <div className="flex items-center gap-4 md:gap-8 w-full">
      <MobileNav items={items} />
      <Link
        href="/"
        className="flex items-center space-x-2 shrink-0 transition-opacity hover:opacity-80"
      >
        <Icons.logo className="h-6 w-6" />
        <span className="inline-block font-bold tracking-tight text-lg">
          {siteConfig.name}
        </span>
      </Link>
      {items?.length ? (
        <nav className="hidden md:flex items-center gap-1">
          {items?.map((item: NavItem, index: number) => {
            if (!item.href) return null;
            const isLocked = item.requiresAuth && !session;
            const href = isLocked
              ? `/signin?callbackUrl=${encodeURIComponent(item.href)}`
              : item.href;

            return (
              <Link
                key={index}
                href={href}
                prefetch={false}
                className={cn(
                  "px-3 py-2 rounded-md text-sm font-medium transition-colors inline-flex items-center gap-1.5",
                  isLocked
                    ? "text-muted-foreground/40 hover:text-muted-foreground/60"
                    : pathname === item.href
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-secondary/50",
                  item.disabled && "cursor-not-allowed opacity-80",
                )}
                title={isLocked ? "Sign in to access" : undefined}
              >
                {item.title}
                {isLocked && (
                  <Lock className="h-3 w-3" aria-hidden="true" />
                )}
              </Link>
            );
          })}
        </nav>
      ) : null}
      <div className="ml-auto flex items-center gap-3">
        {!pathname?.startsWith("/docs/api") && <NavSearchInput />}
        <UserAuthNav />
        {modeToggle}
      </div>
    </div>
  );
};
