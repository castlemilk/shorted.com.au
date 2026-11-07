"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BookOpen,
  GitCommitHorizontal,
  CircleAlert,
  Lock,
  Rss,
} from "lucide-react";
import { useSession } from "next-auth/react";
import { siteConfig } from "~/@/config/site";
import { Badge } from "~/@/components/ui/badge";
import { Icons } from "~/@/components/ui/icons";
import {
  GitHubIcon,
  LinkedInIcon,
  XIcon,
} from "~/@/components/ui/social-icons";
import { eyebrow } from "~/@/lib/typography";
import { cn, isPlainLeftClick } from "~/@/lib/utils";

interface FooterLink {
  title: string;
  href: string;
  requiresAuth?: boolean;
}

const productLinks: FooterLink[] = [
  { title: "Top Shorted", href: "/top" },
  { title: "Industry Intelligence", href: "/industry-intelligence" },
  { title: "Dashboard", href: "/dashboards", requiresAuth: true },
  { title: "Portfolio", href: "/portfolio", requiresAuth: true },
  { title: "Industry Heatmap", href: "/top#treemap" },
  { title: "Reports", href: "/reports" },
  { title: "Market Snapshots", href: "/market" },
  { title: "Company Directory", href: "/directory" },
  { title: "Short Selling Statistics", href: "/statistics" },
  { title: "Short Interest Scans", href: "/scans" },
  { title: "ASX Stock Picker", href: "/strategies" },
];

const resourceLinks: FooterLink[] = [
  { title: "News", href: "/news" },
  { title: "Blog", href: "/blog" },
  { title: "Learn", href: "/learn" },
  { title: "Glossary", href: "/glossary" },
  { title: "FAQ", href: "/faq" },
  { title: "Compare Stocks", href: "/compare" },
  { title: "Seasonality", href: "/seasonality" },
  { title: "About & Founder", href: "/about" },
  { title: "Pricing", href: "/pricing" },
  { title: "Press & Media", href: "/press" },
  { title: "Open Data", href: "/data" },
  { title: "Roadmap", href: "/roadmap" },
];

const legalLinks: FooterLink[] = [
  { title: "Terms", href: "/terms" },
  { title: "Privacy", href: "/privacy" },
  { title: "Disclaimer", href: "/disclaimer" },
  { title: "Methodology", href: "/methodology" },
  { title: "API Docs", href: "/docs/api" },
];

const columns: { title: string; links: FooterLink[] }[] = [
  { title: "Product", links: productLinks },
  { title: "Resources", links: resourceLinks },
  { title: "Legal & Dev", links: legalLinks },
];

function FooterLinkItem({
  link,
  isLocked,
}: {
  link: FooterLink;
  isLocked: boolean;
}) {
  const router = useRouter();

  // Locked items bounce to signin on click, but the anchor keeps the real
  // destination — baking /signin?callbackUrl= into the href leaked sitewide
  // internal link equity to a signin URL (crawlers read the signed-out
  // SSR'd anchor). The real destination is no better for a crawler, though:
  // signed out, /dashboards and /portfolio 307 to the noindexed /signin, and
  // the footer linked them from 46 of the 47 pages probed on 2026-10-21. So a
  // locked link is nofollow. The footer is a client component and SSR has no
  // session, so every server render is the signed-out one.
  return (
    <li>
      <Link
        href={link.href}
        prefetch={false}
        rel={isLocked ? "nofollow" : undefined}
        onClick={(e) => {
          // Plain left-clicks only: modified clicks keep native
          // open-in-new-tab on the real destination.
          if (isLocked && isPlainLeftClick(e)) {
            e.preventDefault();
            router.push(
              `/signin?callbackUrl=${encodeURIComponent(link.href)}`,
            );
          }
        }}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        {link.title}
        {isLocked && <Lock className="h-2.5 w-2.5" aria-hidden="true" />}
      </Link>
    </li>
  );
}

/**
 * A square icon control for a profile or feed: 32px drawn (over the 24px
 * floor), a hairline border, and the label in `aria-label` and `title`, so
 * the icon can stay decorative. `external` opens a new tab with `rel="me"`,
 * which names the profile as this site's own (IndieAuth, Mastodon
 * verification) alongside `noopener`.
 */
function SocialLink({
  href,
  label,
  icon,
  external = true,
}: {
  href: string;
  label: string;
  icon: ReactNode;
  external?: boolean;
}) {
  return (
    <li>
      <a
        href={href}
        aria-label={label}
        title={label}
        target={external ? "_blank" : undefined}
        rel={external ? "noopener me" : undefined}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/60 text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        {icon}
      </a>
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
        <div className="grid grid-cols-2 gap-x-8 gap-y-10 md:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))] md:gap-x-10 lg:gap-x-14">
          {/* Brand column */}
          <div className="col-span-2 md:col-span-1">
            <Link
              href="/"
              className="mb-4 inline-flex items-center gap-2 transition-opacity hover:opacity-80"
            >
              <Icons.logo className="h-6 w-6" />
              <span className="text-lg font-bold tracking-tight">
                {siteConfig.name}
              </span>
            </Link>
            <p className="mb-3 max-w-[300px] text-sm text-muted-foreground">
              Official ASIC short position data for ASX stocks. Updated daily
              with T+4 delay.
            </p>
            <p className="mb-6 flex items-center gap-1.5 text-xs text-muted-foreground">
              <CircleAlert className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
              <span>Not financial advice.</span>
            </p>

            <p className={cn(eyebrow, "mb-3")}>Follow Shorted</p>
            <ul className="flex items-center gap-2" aria-label="Shorted on the web">
              <SocialLink
                href={siteConfig.links.twitter}
                label={`Shorted on X (${siteConfig.twitterHandle})`}
                icon={<XIcon className="h-4 w-4" />}
              />
              <SocialLink
                href={siteConfig.links.rss}
                label="RSS feed"
                icon={<Rss className="h-4 w-4" aria-hidden="true" />}
                external={false}
              />
            </ul>
          </div>

          {columns.map((column) => (
            <nav key={column.title} aria-label={column.title}>
              <p className={cn(eyebrow, "mb-4")}>{column.title}</p>
              <ul className="space-y-2.5">
                {column.links.map((link) => (
                  <FooterLinkItem
                    key={link.href + link.title}
                    link={link}
                    isLocked={!!link.requiresAuth && !session}
                  />
                ))}
              </ul>
            </nav>
          ))}
        </div>

        {/* Founder band */}
        <div className="mt-12 flex flex-col gap-4 border-t border-border/40 pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            Built in {siteConfig.company.city} by{" "}
            <a
              href={siteConfig.founder.website}
              target="_blank"
              rel="noopener me"
              className="font-medium text-foreground underline underline-offset-4 transition-colors hover:text-primary"
            >
              {siteConfig.founder.name}
            </a>
            , {siteConfig.founder.jobTitle.toLowerCase()}.
          </p>
          <ul
            className="flex items-center gap-2"
            aria-label={`${siteConfig.founder.name} on the web`}
          >
            <SocialLink
              href={siteConfig.founder.linkedin}
              label={`${siteConfig.founder.name} on LinkedIn`}
              icon={<LinkedInIcon className="h-4 w-4" />}
            />
            <SocialLink
              href={siteConfig.founder.twitter}
              label={`${siteConfig.founder.name} on X (${siteConfig.founder.twitterHandle})`}
              icon={<XIcon className="h-4 w-4" />}
            />
            <SocialLink
              href={siteConfig.founder.blog}
              label={`${siteConfig.founder.name}'s blog`}
              icon={<BookOpen className="h-4 w-4" aria-hidden="true" />}
            />
            <SocialLink
              href={siteConfig.founder.github}
              label={`${siteConfig.founder.name} on GitHub`}
              icon={<GitHubIcon className="h-4 w-4" />}
            />
          </ul>
        </div>
      </div>

      {/* Bottom bar */}
      <div className="border-t border-border/40">
        <div className="container flex flex-col gap-3 px-4 py-4 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between md:px-6">
          <p>
            Data sourced from{" "}
            <a
              href="https://asic.gov.au/regulatory-resources/markets/short-selling/short-position-reports-table/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 transition-colors hover:text-foreground"
            >
              ASIC
            </a>{" "}
            with T+4 trading day delay. Not financial advice.
          </p>
          <div className="flex items-center gap-3">
            <Badge
              variant="secondary"
              className="cursor-help font-normal"
              title={
                buildTitleParts.length > 0
                  ? buildTitleParts.join("\n")
                  : "Build info not available"
              }
            >
              <GitCommitHorizontal className="mr-1 h-3 w-3" aria-hidden="true" />
              {version}
            </Badge>
            <p className="whitespace-nowrap">
              &copy; {new Date().getFullYear()} {siteConfig.name}
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default SiteFooter;
