"use client";

import { cn } from "~/@/lib/utils";
import { Button } from "~/@/components/ui/button";
import { ScrollArea } from "~/@/components/ui/scroll-area";
import {
  TrendingUp,
  Briefcase,
  LayoutDashboard,
  LineChart,
  FileText,
  Code2,
  Activity,
  Bell,
  Lock,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { useSubscription } from "~/@/hooks/use-subscription";

interface SidebarProps {
  className?: string;
}

interface SidebarItem {
  title: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  premium?: boolean;
}

const sidebarItems: SidebarItem[] = [
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
    title: "Reports",
    href: "/reports",
    icon: FileText,
  },
  {
    title: "Portfolio",
    href: "/portfolio",
    icon: Briefcase,
  },
  {
    title: "Pulse",
    href: "/pulse",
    icon: Activity,
    premium: true,
  },
  {
    title: "Alerts",
    href: "/alerts",
    icon: Bell,
    premium: true,
  },
  {
    title: "Developer",
    href: "/developer",
    icon: Code2,
  },
];

export function Sidebar({ className }: SidebarProps) {
  const pathname = usePathname();
  const { data: session, status } = useSession();
  const { isPremium } = useSubscription();

  // Don't render sidebar if user is not authenticated
  if (status === "loading") {
    return null;
  }

  if (!session) {
    return null;
  }

  const SidebarContent = ({ showLabels = true }: { showLabels?: boolean }) => (
    <ScrollArea className="flex-1 py-2">
      <nav className="grid gap-1 px-2">
        {sidebarItems.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href;
          const isLocked = item.premium && !isPremium;
          const href = isLocked ? "/pricing" : item.href;

          return (
            <Link key={item.href} href={href} prefetch={false}>
              <Button
                variant={isActive ? "secondary" : "ghost"}
                className={cn(
                  "w-full gap-2",
                  showLabels ? "justify-start" : "justify-center",
                  isActive && "bg-secondary",
                  isLocked && "opacity-60",
                )}
                title={!showLabels ? item.title : undefined}
              >
                <Icon className="h-4 w-4" />
                {showLabels && (
                  <span className="flex items-center gap-1.5">
                    {item.title}
                    {isLocked && <Lock className="h-3 w-3 text-muted-foreground" />}
                  </span>
                )}
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
