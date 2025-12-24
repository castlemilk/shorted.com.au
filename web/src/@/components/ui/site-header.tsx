"use client";

import { type FC } from "react";
import { MainNav } from "./main-nav";
import { ModeToggle } from "./mode-toggle";
import { useSession } from "next-auth/react";

const SiteHeader: FC = () => {
  const { data: session } = useSession();
  
  const items = [
    ...(session ? [
      { title: "dashboard", href: "/dashboards" },
      { title: "portfolio", href: "/portfolio" }
    ] : []),
    { title: "about", href: "/about" },
    { title: "blog", href: "/blog" },
  ];
  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/80 backdrop-blur-xl saturate-150 supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-16 items-center">
        <MainNav items={items}/>
        <div className="flex items-center gap-2">
          <ModeToggle />
        </div>
      </div>
    </header>
  );
};

export default SiteHeader;
