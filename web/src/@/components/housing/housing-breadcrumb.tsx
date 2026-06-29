import Link from "next/link";

export function HousingBreadcrumb({ trail }: { trail: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      {trail.map((c, i) => (
        <span key={i} className="flex items-center gap-1">
          {c.href ? (
            <Link href={c.href} className="transition-colors hover:text-foreground">{c.label}</Link>
          ) : (
            <span className="text-foreground">{c.label}</span>
          )}
          {i < trail.length - 1 ? <span aria-hidden>›</span> : null}
        </span>
      ))}
    </nav>
  );
}
