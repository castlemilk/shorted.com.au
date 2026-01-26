"use client";

import { cn } from "~/@/lib/utils";
import { Button } from "~/@/components/ui/button";
import { ScrollArea } from "~/@/components/ui/scroll-area";
import {
  TrendingUp,
  Briefcase,
  LayoutDashboard,
  LineChart,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
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
  const { data: session, status } = useSession();

  // Don't render sidebar if user is not authenticated
  if (status === "loading") {
    return null; // or could return a loading skeleton
  }

  if (!session) {
    return null; // Don't show sidebar for unauthenticated users
  }

  const SidebarContent = ({ showLabels = true }: { showLabels?: boolean }) => (
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
                  "w-full gap-2",
                  showLabels ? "justify-start" : "justify-center",
                  isActive && "bg-secondary",
                )}
                title={!showLabels ? item.title : undefined}
              >
                <Icon className="h-4 w-4" />
                {showLabels && <span>{item.title}</span>}
              </Button>
            </Link>
          );
        })}
      </nav>
    </ScrollArea>
  );

  return (
    <>
      {/* Sidebar - Always visible, icons on small/medium, full labels on large */}
      <aside
        className={cn(
          "flex flex-col bg-background border-r transition-all duration-300",
          "w-16 lg:w-64",
          className,
        )}
      >
        {/* Show icons only on small/medium, full labels on lg */}
        <div className="hidden lg:block">
          <SidebarContent showLabels={true} />
        </div>
        <div className="block lg:hidden">
          <SidebarContent showLabels={false} />
        </div>
      </aside>
    </>
  );
}
