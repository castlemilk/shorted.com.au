import { FC } from "react";
import { MainNav } from "./main-nav";
import { ModeToggle } from "./mode-toggle";

const SiteHeader: FC = () => {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-14 max-w-screen-2xl items-center">
        <MainNav />
        <div className="flex flex-1 items-center justify-between space-x-2 md:justify-end">
        <nav className="flex items-center">
          <ModeToggle />
        </nav>
      </div>
      </div>
      
    </header>
  );
};

export default SiteHeader;
