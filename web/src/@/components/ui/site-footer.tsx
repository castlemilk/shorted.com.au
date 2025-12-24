/* eslint-disable @typescript-eslint/no-unsafe-assignment */
"use client";

import Link from "next/link";
import { File, RouteIcon, GitCommit, Terminal } from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { Badge } from "~/@/components/ui/badge";

const SiteFooter = () => {
  // `next/config` is not supported in the Next.js App Router on the client.
  // Prefer env vars if present; fall back to a safe label.
  const version = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
  const gitCommit = process.env.NEXT_PUBLIC_GIT_COMMIT;
  const gitBranch = process.env.NEXT_PUBLIC_GIT_BRANCH;
  const buildDate = process.env.NEXT_PUBLIC_BUILD_DATE;
  const environment = process.env.NEXT_PUBLIC_ENVIRONMENT;

  const buildTitleParts = [
    buildDate ? `Build: ${buildDate}` : null,
    gitCommit ? `Commit: ${gitCommit}` : null,
    gitBranch ? `Branch: ${gitBranch}` : null,
    environment ? `Environment: ${environment}` : null,
  ].filter(Boolean);

  return (
    <footer className="py-6 md:px-8 md:py-0">
      <div className="container flex flex-col items-center justify-between gap-4 md:h-24 md:flex-row">
        <p className="text-balance text-center text-sm leading-loose text-muted-foreground md:text-left">
          Built with ❤️ by{" "}
          <a
            href={siteConfig.links.twitter}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline underline-offset-4"
          >
            castlemilk
          </a>
        </p>
        <div className="flex items-center gap-2">
          <Badge 
            variant="secondary" 
            className="cursor-help"
            title={buildTitleParts.length > 0 ? buildTitleParts.join("\n") : "Build info not available"}
          >
            <GitCommit className="w-3 h-3 mr-1" />
            {version}
          </Badge>
          <Link href="/roadmap">
            <Badge variant="secondary" className="hover:bg-secondary/80">
              <RouteIcon className="w-3 h-3 mr-1" />
              roadmap
            </Badge>
          </Link>
          <Link href="/docs/api">
            <Badge variant="secondary" className="hover:bg-secondary/80">
              <Terminal className="w-3 h-3 mr-1 text-blue-500" />
              api docs
            </Badge>
          </Link>
          <Link href="/terms">
            <Badge variant="secondary" className="hover:bg-secondary/80">
              <File className="w-3 h-3 mr-1" />
              terms
            </Badge>
          </Link>
        </div>
      </div>
    </footer>
  );
};

export default SiteFooter;
