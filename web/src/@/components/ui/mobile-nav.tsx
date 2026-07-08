"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, Terminal, Code2, Home, Info, FileText, LayoutDashboard, Briefcase, TrendingDown, Lock, Cpu, BarChart3 } from "lucide-react";
import { useSession } from "next-auth/react";

import { siteConfig } from "~/@/config/site";
import { cn } from "~/@/lib/utils";
import { Button } from "~/@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "~/@/components/ui/sheet";
import { Icons } from "~/@/components/ui/icons";
import type { NavItemWithGroup } from "./site-header";

interface MobileNavProps {
  items?: NavItemWithGroup[];
}

export function MobileNav({ items }: MobileNavProps) {
  const [open, setOpen] = React.useState(false);
  const pathname = usePathname();
  const { data: session } = useSession();

  const getIcon = (title: string) => {
    switch (title.toLowerCase()) {
      case 'top shorted': return <TrendingDown className="h-4 w-4" />;
      case 'dashboard': return <LayoutDashboard className="h-4 w-4" />;
      case 'portfolio': return <Briefcase className="h-4 w-4" />;
      case 'about': return <Info className="h-4 w-4" />;
      case 'technology': return <Cpu className="h-4 w-4" />;
      case 'metrics': return <BarChart3 className="h-4 w-4" />;
      case 'blog': return <FileText className="h-4 w-4" />;
      case 'developer': return <Code2 className="h-4 w-4" />;
      default: return <Home className="h-4 w-4" />;
    }
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          className="mr-2 px-0 text-base hover:bg-transparent focus-visible:bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 lg:hidden"
        >
          <Menu className="h-6 w-6" />
          <span className="sr-only">Toggle Menu</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="pr-0">
        <Link
          href="/"
          className="flex items-center space-x-2"
          onClick={() => setOpen(false)}
        >
          <Icons.logo className="h-6 w-6" />
          <span className="font-bold">{siteConfig.name}</span>
        </Link>
        <div className="my-4 h-[calc(100vh-8rem)] pb-10 pl-6">
          <div className="flex flex-col space-y-3">
            {items?.map((item) => {
              if (!item.href) return null;
              const isLocked = item.requiresAuth && !session;
              const href = isLocked
                ? `/signin?callbackUrl=${encodeURIComponent(item.href)}`
                : item.href;

              return (
                <Link
                  key={item.href}
                  href={href}
                  prefetch={false}
                  className={cn(
                    "flex items-center gap-2 transition-colors",
                    isLocked
                      ? "text-muted-foreground/40"
                      : "text-muted-foreground hover:text-foreground",
                    pathname === item.href && !isLocked && "text-foreground font-bold"
                  )}
                  onClick={() => setOpen(false)}
                >
                  {getIcon(item.title)}
                  {item.title}
                  {isLocked && (
                    <Lock className="h-3 w-3 ml-auto mr-6" aria-hidden="true" />
                  )}
                </Link>
              );
            })}
            <div className="pt-4 mt-4 border-t border-border pr-6">
              <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">Resources</h4>
              <Link
                href="/docs/api"
                prefetch={false}
                className={cn(
                  "flex items-center gap-2 text-muted-foreground transition-colors hover:text-foreground",
                  pathname.startsWith("/docs/api") && "text-foreground font-bold"
                )}
                onClick={() => setOpen(false)}
              >
                <Terminal className="h-4 w-4" />
                API Documentation
              </Link>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
