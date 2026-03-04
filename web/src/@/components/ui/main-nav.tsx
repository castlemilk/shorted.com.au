"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, Lock } from "lucide-react";
import { useSession } from "next-auth/react";

import { siteConfig } from "~/@/config/site";
import { cn } from "~/@/lib/utils";
import { Icons } from "~/@/components/ui/icons";
import { UserAuthNav } from "~/@/components/ui/user-auth-nav";
import { NavSearchInput } from "~/@/components/ui/nav-search-input";
import { Popover, PopoverContent, PopoverTrigger } from "~/@/components/ui/popover";
import { MobileNav } from "./mobile-nav";
import { type NavItemWithGroup } from "./site-header";

interface MainNavProps {
  items?: NavItemWithGroup[];
  modeToggle?: React.ReactNode;
}

export const MainNav = ({ items, modeToggle }: MainNavProps) => {
  const pathname = usePathname();
  const { data: session } = useSession();
  const [moreOpen, setMoreOpen] = React.useState(false);

  const primaryItems = React.useMemo(
    () => items?.filter((i) => i.primary) ?? [],
    [items]
  );
  const secondaryItems = React.useMemo(
    () => items?.filter((i) => !i.primary) ?? [],
    [items]
  );

  // Check if any secondary item is currently active
  const isSecondaryActive = secondaryItems.some((i) => i.href && pathname === i.href);

  return (
    <div className="flex items-center gap-4 md:gap-6 w-full">
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
        <nav className="hidden md:flex items-center gap-0.5">
          {/* Primary items — always visible */}
          {primaryItems.map((item, index) => (
            <NavLink
              key={index}
              item={item}
              pathname={pathname}
              session={session}
            />
          ))}

          {/* "More" dropdown for secondary items */}
          {secondaryItems.length > 0 && (
            <Popover open={moreOpen} onOpenChange={setMoreOpen}>
              <PopoverTrigger asChild>
                <button
                  className={cn(
                    "px-3 py-2 rounded-md text-sm font-medium transition-colors inline-flex items-center gap-1",
                    isSecondaryActive
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                  )}
                >
                  More
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 transition-transform duration-200",
                      moreOpen && "rotate-180"
                    )}
                  />
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                sideOffset={8}
                className="w-48 p-1.5 rounded-xl"
              >
                <div className="flex flex-col">
                  {secondaryItems.map((item, index) => {
                    if (!item.href) return null;
                    const isLocked = item.requiresAuth && !session;
                    const href = isLocked
                      ? `/signin?callbackUrl=${encodeURIComponent(item.href)}`
                      : item.href;
                    const isActive = pathname === item.href;

                    return (
                      <Link
                        key={index}
                        href={href}
                        prefetch={false}
                        className={cn(
                          "px-3 py-2 rounded-lg text-sm font-medium transition-colors inline-flex items-center gap-2",
                          isLocked
                            ? "text-muted-foreground/40 hover:text-muted-foreground/60"
                            : isActive
                              ? "bg-secondary text-foreground"
                              : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                        )}
                        onClick={() => setMoreOpen(false)}
                        title={isLocked ? "Sign in to access" : undefined}
                      >
                        {item.title}
                        {isLocked && (
                          <Lock className="h-3 w-3" aria-hidden="true" />
                        )}
                      </Link>
                    );
                  })}
                </div>
              </PopoverContent>
            </Popover>
          )}
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

/** Single nav link item */
function NavLink({
  item,
  pathname,
  session,
}: {
  item: NavItemWithGroup;
  pathname: string;
  session: ReturnType<typeof useSession>["data"];
}) {
  if (!item.href) return null;
  const isLocked = item.requiresAuth && !session;
  const href = isLocked
    ? `/signin?callbackUrl=${encodeURIComponent(item.href)}`
    : item.href;

  return (
    <Link
      href={href}
      prefetch={false}
      className={cn(
        "px-3 py-2 rounded-md text-sm font-medium transition-colors inline-flex items-center gap-1.5 whitespace-nowrap",
        isLocked
          ? "text-muted-foreground/40 hover:text-muted-foreground/60"
          : pathname === item.href
            ? "bg-secondary text-foreground"
            : "text-muted-foreground hover:text-foreground hover:bg-secondary/50",
        item.disabled && "cursor-not-allowed opacity-80"
      )}
      title={isLocked ? "Sign in to access" : undefined}
    >
      {item.title}
      {isLocked && <Lock className="h-3 w-3" aria-hidden="true" />}
    </Link>
  );
}
