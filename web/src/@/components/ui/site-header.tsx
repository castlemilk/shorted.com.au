import { type FC } from "react";
import { MainNav } from "./main-nav";
import { ModeToggle } from "./mode-toggle";

const SiteHeader: FC = () => {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="pr-5 pl-5 flex w-full h-14 items-center">
        <MainNav items={[{ title: "about", href: "/about" }, { title: "blog", href: "/blog" }]} />
        <div className="flex flex-1 items-center space-x-2 justify-end">
          <nav className="flex items-center">
            <ModeToggle />
          </nav>
        </div>
      </div>
    </header>
  );
};

export default SiteHeader;
