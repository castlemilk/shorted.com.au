/* eslint-disable @typescript-eslint/no-unsafe-assignment */
"use client";

import Link from "next/link";
import { File, RouteIcon, GitCommit, Terminal, AlertCircle } from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { Badge } from "~/@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/@/components/ui/tooltip";

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
      {/* ASIC Data Disclaimer */}
      <div className="container mb-4 md:mb-0">
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground/70 border-t border-border/40 pt-4">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-1.5 cursor-help">
                  <AlertCircle className="h-3 w-3" />
                  <span>
                    Data sourced from{" "}
                    <a
                      href="https://asic.gov.au/regulatory-resources/markets/short-selling/short-position-reports-table/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-2 hover:text-foreground"
                    >
                      ASIC
                    </a>
                    {" "}with T+4 trading day delay. Not financial advice.
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                <p className="text-xs">
                  Short position data is reported to ASIC by market participants and published
                  with a T+4 trading day delay. This means data shown reflects positions from
                  4 trading days ago. This information is for general purposes only and should
                  not be relied upon for investment decisions.
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
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
            title={
              buildTitleParts.length > 0
                ? buildTitleParts.join("\n")
                : "Build info not available"
            }
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
