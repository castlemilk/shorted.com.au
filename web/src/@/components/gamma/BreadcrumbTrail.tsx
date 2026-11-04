import type { HTMLAttributes, ReactNode } from "react";
import { ChevronRight } from "lucide-react";

export type BreadcrumbItem = { label: string; href?: string; icon?: ReactNode };
export type BreadcrumbTrailProps = HTMLAttributes<HTMLElement> & {
  items: BreadcrumbItem[];
  label?: string;
};

/** Hierarchical links with a labelled navigation landmark and one current page. */
export function BreadcrumbTrail({
  items,
  label = "Breadcrumb",
  className = "",
  ...navProps
}: BreadcrumbTrailProps) {
  if (!items.length) return null;
  return (
    <nav
      {...navProps}
      className={`breadcrumb-trail ${className}`}
      aria-label={navProps["aria-label"] ?? label}
    >
      <ol>
        {items.map((item, index) => {
          const current = index === items.length - 1;
          const content = (
            <>
              {item.icon && (
                <span className="breadcrumb-trail-icon" aria-hidden="true">
                  {item.icon}
                </span>
              )}
              <span>{item.label}</span>
            </>
          );
          return (
            <li key={`${item.href ?? item.label}-${index}`}>
              {index > 0 && (
                <ChevronRight
                  className="breadcrumb-trail-separator"
                  size={13}
                  aria-hidden="true"
                />
              )}
              {item.href && !current ? (
                <a href={item.href}>{content}</a>
              ) : (
                <span
                  className="breadcrumb-trail-item"
                  aria-current={current ? "page" : undefined}
                >
                  {content}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
