"use client";

import Link from "next/link";
import { ChevronRight, Home } from "lucide-react";
import { Fragment } from "react";

interface BreadcrumbItem {
  label: string;
  href: string;
}

interface BreadcrumbsProps {
  items: BreadcrumbItem[];
  className?: string;
  /**
   * Forwarded to every link of the trail. Left out, Next's own default applies
   * (a link is prefetched as it scrolls into view), so no page that uses this
   * component changes; a page opts out for itself. The stock tabs pass `false`:
   * their trail links to the stock's Overview, an ISR route, and a viewport
   * prefetch would fetch (and on a cold cache generate) it on every tab view.
   */
  prefetch?: boolean;
}

export function Breadcrumbs({
  items,
  className = "",
  prefetch,
}: BreadcrumbsProps) {
  return (
    <nav
      aria-label="Breadcrumb"
      className={`flex items-center space-x-1 text-sm text-muted-foreground ${className}`}
    >
      <Link
        href="/"
        prefetch={prefetch}
        className="flex items-center hover:text-foreground transition-colors"
        aria-label="Home"
      >
        <Home className="h-4 w-4" />
      </Link>

      {items.map((item, index) => (
        <Fragment key={item.href}>
          <ChevronRight className="h-4 w-4" />
          {index === items.length - 1 ? (
            <span className="font-medium text-foreground" aria-current="page">
              {item.label}
            </span>
          ) : (
            <Link
              href={item.href}
              prefetch={prefetch}
              className="hover:text-foreground transition-colors"
            >
              {item.label}
            </Link>
          )}
        </Fragment>
      ))}
    </nav>
  );
}

// Structured data for breadcrumbs
export function BreadcrumbStructuredData({
  items,
}: {
  items: BreadcrumbItem[];
}) {
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: "https://shorted.com.au/",
      },
      ...items.map((item, index) => ({
        "@type": "ListItem",
        position: index + 2,
        name: item.label,
        item: `https://shorted.com.au${item.href}`,
      })),
    ],
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(structuredData),
      }}
    />
  );
}
