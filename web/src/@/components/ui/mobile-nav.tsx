"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, Terminal, Home, Info, FileText, LayoutDashboard, Briefcase } from "lucide-react";

import { siteConfig } from "~/@/config/site";
import { cn } from "~/@/lib/utils";
import { Button } from "~/@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "~/@/components/ui/sheet";
import { Icons } from "~/@/components/ui/icons";
import type { NavItem } from "~/@/types/nav";

interface MobileNavProps {
  items?: NavItem[];
}

export function MobileNav({ items }: MobileNavProps) {
  const [open, setOpen] = React.useState(false);
  const pathname = usePathname();

  const getIcon = (title: string) => {
    switch (title.toLowerCase()) {
      case 'dashboard': return <LayoutDashboard className="h-4 w-4" />;
      case 'portfolio': return <Briefcase className="h-4 w-4" />;
      case 'about': return <Info className="h-4 w-4" />;
      case 'blog': return <FileText className="h-4 w-4" />;
      default: return <Home className="h-4 w-4" />;
    }
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          className="mr-2 px-0 text-base hover:bg-transparent focus-visible:bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 md:hidden"
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
            {items?.map(
              (item) =>
                item.href && (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "flex items-center gap-2 text-muted-foreground transition-colors hover:text-foreground",
                      pathname === item.href && "text-foreground font-bold"
                    )}
                    onClick={() => setOpen(false)}
                  >
                    {getIcon(item.title)}
                    {item.title}
                  </Link>
                )
            )}
            <div className="pt-4 mt-4 border-t border-border pr-6">
              <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">Resources</h4>
              <Link
                href="/docs/api"
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

