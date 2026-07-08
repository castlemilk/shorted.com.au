"use client";

import Link from "next/link";
import { GitCommit, AlertCircle, Lock } from "lucide-react";
import { useSession } from "next-auth/react";
import { siteConfig } from "~/@/config/site";
import { Badge } from "~/@/components/ui/badge";
import { Icons } from "~/@/components/ui/icons";
import { cn } from "~/@/lib/utils";

interface FooterLink {
  title: string;
  href: string;
  requiresAuth?: boolean;
}

const productLinks: FooterLink[] = [
  { title: "Top Shorted", href: "/top" },
  { title: "Dashboard", href: "/dashboards", requiresAuth: true },
  { title: "Portfolio", href: "/portfolio", requiresAuth: true },
  { title: "Industry Heatmap", href: "/top#treemap" },
  { title: "Reports", href: "/reports" },
  { title: "Market Snapshots", href: "/reports" },
  { title: "Company Directory", href: "/directory" },
];

const resourceLinks: FooterLink[] = [
  { title: "News", href: "/news" },
  { title: "Blog", href: "/blog" },
  { title: "Learn", href: "/learn" },
  { title: "Glossary", href: "/glossary" },
  { title: "FAQ", href: "/faq" },
  { title: "Compare Stocks", href: "/compare" },
  { title: "Seasonality", href: "/seasonality" },
  { title: "About", href: "/about" },
  { title: "Roadmap", href: "/roadmap" },
];

const legalLinks: FooterLink[] = [
  { title: "Terms", href: "/terms" },
  { title: "Privacy", href: "/privacy" },
  { title: "Disclaimer", href: "/disclaimer" },
  { title: "Methodology", href: "/methodology" },
  { title: "API Docs", href: "/docs/api" },
];

function FooterLinkItem({
  link,
  isLocked,
}: {
  link: FooterLink;
  isLocked: boolean;
}) {
  const href = isLocked
    ? `/signin?callbackUrl=${encodeURIComponent(link.href)}`
    : link.href;

  return (
    <li>
      <Link
        href={href}
        prefetch={false}
        className={cn(
          "text-sm transition-colors inline-flex items-center gap-1.5",
          isLocked
            ? "text-muted-foreground hover:text-foreground"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        {link.title}
        {isLocked && (
          <Lock className="h-2.5 w-2.5" aria-hidden="true" />
        )}
      </Link>
    </li>
  );
}

const SiteFooter = () => {
  const version = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
  const gitCommit = process.env.NEXT_PUBLIC_GIT_COMMIT;
  const gitBranch = process.env.NEXT_PUBLIC_GIT_BRANCH;
  const buildDate = process.env.NEXT_PUBLIC_BUILD_DATE;
  const environment = process.env.NEXT_PUBLIC_ENVIRONMENT;
  const { data: session } = useSession();

  const buildTitleParts = [
    buildDate ? `Build: ${buildDate}` : null,
    gitCommit ? `Commit: ${gitCommit}` : null,
    gitBranch ? `Branch: ${gitBranch}` : null,
    environment ? `Environment: ${environment}` : null,
  ].filter(Boolean);

  return (
    <footer className="relative z-10 border-t border-border/40 bg-background">
      <div className="container px-4 md:px-6 py-12 md:py-16">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 md:gap-12">
          {/* Brand column */}
          <div className="col-span-2 md:col-span-1">
            <Link
              href="/"
              className="flex items-center space-x-2 mb-4 transition-opacity hover:opacity-80"
            >
              <Icons.logo className="h-6 w-6" />
              <span className="font-bold tracking-tight text-lg">
                {siteConfig.name}
              </span>
            </Link>
            <p className="text-sm text-muted-foreground mb-4 max-w-[280px]">
              Official ASIC short position data for ASX stocks. Updated daily
              with T+4 delay.
            </p>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-4">
              <AlertCircle className="h-3 w-3 flex-shrink-0" />
              <span>Not financial advice.</span>
            </div>
            <p className="text-sm text-muted-foreground mb-3">
              Built with{" "}
              <span aria-label="love" role="img" className="text-rose-500">
                ❤️
              </span>{" "}
              in{" "}
              <a
                href="https://benebsworth.com"
                target="_blank"
                rel="noreferrer"
                className="font-medium underline underline-offset-4 hover:text-foreground transition-colors"
              >
                Melbourne
              </a>
            </p>
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
          </div>

          {/* Product */}
          <div>
            <p className="text-sm font-semibold mb-4">Product</p>
            <ul className="space-y-2.5">
              {productLinks.map((link) => (
                <FooterLinkItem
                  key={link.href + link.title}
                  link={link}
                  isLocked={!!link.requiresAuth && !session}
                />
              ))}
            </ul>
          </div>

          {/* Resources */}
          <div>
            <p className="text-sm font-semibold mb-4">Resources</p>
            <ul className="space-y-2.5">
              {resourceLinks.map((link) => (
                <FooterLinkItem
                  key={link.href + link.title}
                  link={link}
                  isLocked={!!link.requiresAuth && !session}
                />
              ))}
            </ul>
          </div>

          {/* Legal & Dev */}
          <div>
            <p className="text-sm font-semibold mb-4">Legal & Dev</p>
            <ul className="space-y-2.5">
              {legalLinks.map((link) => (
                <FooterLinkItem
                  key={link.href + link.title}
                  link={link}
                  isLocked={!!link.requiresAuth && !session}
                />
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* Bottom bar */}
      <div className="border-t border-border/40">
        <div className="container px-4 md:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-muted-foreground">
          <p>
            Data sourced from{" "}
            <a
              href="https://asic.gov.au/regulatory-resources/markets/short-selling/short-position-reports-table/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground transition-colors"
            >
              ASIC
            </a>{" "}
            with T+4 trading day delay. Not financial advice.
          </p>
          <p>&copy; {new Date().getFullYear()} Shorted</p>
        </div>
      </div>
    </footer>
  );
};

export default SiteFooter;
