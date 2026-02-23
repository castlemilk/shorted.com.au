"use client";

import { type FC } from "react";
import { MainNav } from "./main-nav";
import { ModeToggle } from "./mode-toggle";
import { useSession } from "next-auth/react";

const SiteHeader: FC = () => {
  const { data: session } = useSession();

  const items = [
    { title: "top shorted", href: "/top" },
    ...(session
      ? [
          { title: "dashboard", href: "/dashboards" },
          { title: "portfolio", href: "/portfolio" },
          { title: "developer", href: "/developer" },
        ]
      : []),
    { title: "reports", href: "/reports" },
    { title: "about", href: "/about" },
    { title: "blog", href: "/blog" },
  ];
  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/80 backdrop-blur-xl saturate-150 supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-16 items-center w-full px-4 md:px-6">
        <MainNav items={items} modeToggle={<ModeToggle />} />
      </div>
    </header>
  );
};

export default SiteHeader;
