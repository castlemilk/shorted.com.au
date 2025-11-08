"use client";

import { cn } from "~/@/lib/utils";
import { Button } from "~/@/components/ui/button";
import { ScrollArea } from "~/@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetTrigger } from "~/@/components/ui/sheet";
import {
  TrendingUp,
  Briefcase,
  Menu,
  X,
  LayoutDashboard,
  LineChart,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useSession } from "next-auth/react";

interface SidebarProps {
  className?: string;
}

const sidebarItems = [
  {
    title: "Dashboard",
    href: "/dashboards",
    icon: LayoutDashboard,
  },
  {
    title: "Top Shorts",
    href: "/shorts",
    icon: TrendingUp,
  },
  {
    title: "Stocks",
    href: "/stocks",
    icon: LineChart,
  },
  {
    title: "Portfolio",
    href: "/portfolio",
    icon: Briefcase,
  },
];

export function Sidebar({ className }: SidebarProps) {
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);
  const { data: session, status } = useSession();

  // Don't render sidebar if user is not authenticated
  if (status === "loading") {
    return null; // or could return a loading skeleton
  }

  if (!session) {
    return null; // Don't show sidebar for unauthenticated users
  }

  const SidebarContent = () => (
    <ScrollArea className="flex-1 py-2">
      <nav className="grid gap-1 px-2">
        {sidebarItems.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href;
          return (
            <Link key={item.href} href={item.href}>
              <Button
                variant={isActive ? "secondary" : "ghost"}
                className={cn(
                  "w-full justify-start gap-2",
                  isActive && "bg-secondary",
                )}
                onClick={() => setIsOpen(false)}
              >
                <Icon className="h-4 w-4" />
                {item.title}
              </Button>
            </Link>
          );
        })}
      </nav>
    </ScrollArea>
  );

  return (
    <>
      {/* Mobile Sidebar Trigger */}
      <div className="lg:hidden fixed bottom-4 left-4 z-50">
        <Sheet open={isOpen} onOpenChange={setIsOpen}>
          <SheetTrigger asChild>
            <Button
              size="icon"
              variant="outline"
              className="rounded-full shadow-lg"
            >
              {isOpen ? (
                <X className="h-4 w-4" />
              ) : (
                <Menu className="h-4 w-4" />
              )}
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-64 p-0">
            <div className="flex h-full flex-col">
              <SidebarContent />
            </div>
          </SheetContent>
        </Sheet>
      </div>

      {/* Desktop Sidebar */}
      <aside
        className={cn(
          "hidden lg:flex flex-col w-64 bg-background border-r",
          className,
        )}
      >
        <SidebarContent />
      </aside>
    </>
  );
}
