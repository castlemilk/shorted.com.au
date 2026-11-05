"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown, Lock } from "lucide-react";
import { useSession } from "next-auth/react";

import { siteConfig } from "~/@/config/site";
import { cn, isPlainLeftClick } from "~/@/lib/utils";
import { Icons } from "~/@/components/ui/icons";
import { UserAuthNav } from "~/@/components/ui/user-auth-nav";
import { NavSearchInput } from "~/@/components/ui/nav-search-input";
import { Popover, PopoverContent, PopoverTrigger } from "~/@/components/ui/popover";
import { MobileNav } from "./mobile-nav";
import { type NavItemWithGroup } from "./site-header";

/**
 * Whether the open page is `href` or sits inside it. "/" matches the home page
 * only: every path starts with "/", so a prefix test would light Home on every
 * page. A section stays lit on its own sub-pages ("/ownership/map") but not on
 * a sibling that merely shares the prefix ("/ownershipx").
 */
export function isActivePath(pathname: string, href: string): boolean {
  // An empty href is no destination at all. Every path starts with "", so the
  // prefix test below would light the item on every page.
  if (!href) return false;
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/*
 * Active is a 2px amber underline on the label, never a fill (DESIGN.md,
 * Navigation: "Active state carries Burnt Amber"). Every item carries the same
 * bottom border, transparent when idle, so activating one moves nothing. Sage
 * is --secondary's dark-mode value, so no header item carries the secondary
 * fill at rest: hover tints it in light mode and the muted surface in dark mode.
 */

interface MainNavProps {
  items?: NavItemWithGroup[];
  modeToggle?: React.ReactNode;
}

export const MainNav = ({ items, modeToggle }: MainNavProps) => {
  const pathname = usePathname();
  const router = useRouter();
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
  const isSecondaryActive = secondaryItems.some(
    (i) => !!i.href && isActivePath(pathname, i.href)
  );

  return (
    // gap-2 below sm: the header must fit hamburger + logo + sign-in +
    // theme toggle inside a 320px viewport
    <div className="flex w-full min-w-0 items-center gap-2 sm:gap-3 lg:gap-5">
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
        <nav className="hidden lg:flex min-w-0 items-center gap-0.5">
          {/* Primary items; always visible */}
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
                    "px-3 py-2 rounded-t-md text-sm font-medium transition-colors inline-flex items-center gap-1 border-b-2 hover:bg-secondary/50 dark:hover:bg-muted",
                    isSecondaryActive
                      ? "border-primary text-primary"
                      : "border-transparent text-muted-foreground hover:text-foreground"
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
                    const isActive = !isLocked && isActivePath(pathname, item.href);

                    // Locked items bounce to signin on click, but the anchor
                    // keeps the real destination; baking /signin?callbackUrl=
                    // into the href leaked sitewide internal link equity to a
                    // signin URL (crawlers read the signed-out SSR'd anchor).
                    return (
                      <Link
                        key={index}
                        href={item.href}
                        prefetch={false}
                        aria-current={isActive ? "page" : undefined}
                        className={cn(
                          "px-3 py-2 rounded-lg text-sm font-medium transition-colors inline-flex items-center gap-2",
                          isLocked
                            ? "text-muted-foreground hover:text-foreground"
                            : "text-muted-foreground hover:text-foreground hover:bg-secondary/50 dark:hover:bg-muted"
                        )}
                        onClick={(e) => {
                          setMoreOpen(false);
                          // Plain left-clicks only: modified clicks keep
                          // native open-in-new-tab on the real destination.
                          if (isLocked && isPlainLeftClick(e)) {
                            e.preventDefault();
                            router.push(
                              `/signin?callbackUrl=${encodeURIComponent(item.href!)}`,
                            );
                          }
                        }}
                        title={isLocked ? "Sign in to access" : undefined}
                      >
                        {/* The underline sits on the label, not the row, so the
                            row keeps its rounded-lg and no fill. */}
                        <span
                          className={cn(
                            "border-b-2",
                            isActive
                              ? "border-primary text-primary"
                              : "border-transparent"
                          )}
                        >
                          {item.title}
                        </span>
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

      <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5 sm:gap-2 lg:gap-3">
        {!pathname?.startsWith("/docs/api") && (
          <div className="hidden xl:block">
            <NavSearchInput />
          </div>
        )}
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
  // Hook must run unconditionally, before the early return.
  const router = useRouter();
  if (!item.href) return null;
  const isLocked = item.requiresAuth && !session;
  const isActive = !isLocked && isActivePath(pathname, item.href);

  // Locked items bounce to signin on click, but the anchor keeps the real
  // destination; baking /signin?callbackUrl= into the href leaked sitewide
  // internal link equity to a signin URL (crawlers read the signed-out
  // SSR'd anchor).
  return (
    <Link
      href={item.href}
      prefetch={false}
      aria-current={isActive ? "page" : undefined}
      onClick={(e) => {
        // Plain left-clicks only: modified clicks keep native
        // open-in-new-tab on the real destination.
        if (isLocked && isPlainLeftClick(e)) {
          e.preventDefault();
          router.push(`/signin?callbackUrl=${encodeURIComponent(item.href!)}`);
        }
      }}
      className={cn(
        "px-3 py-2 rounded-t-md text-sm font-medium transition-colors inline-flex items-center gap-1.5 whitespace-nowrap border-b-2",
        isLocked
          ? "border-transparent text-muted-foreground hover:text-foreground"
          : cn(
              "hover:bg-secondary/50 dark:hover:bg-muted",
              isActive
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            ),
        item.disabled && "cursor-not-allowed opacity-80"
      )}
      title={isLocked ? "Sign in to access" : undefined}
    >
      {item.title}
      {isLocked && <Lock className="h-3 w-3" aria-hidden="true" />}
    </Link>
  );
}
