"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Search } from "lucide-react";
import { graphHref } from "~/@/lib/ownership/graph-links";

export type GraphSearchItem = { name: string; detail: string; href: string };
export function GraphSearch({ items }: { items: GraphSearchItem[] }) {
  const [query, setQuery] = useState("");
  const router = useRouter();
  const term = query.trim().toLowerCase();
  const matches = term
    ? items
        .filter((n) => (n.name + " " + n.detail).toLowerCase().includes(term))
        .slice(0, 10)
    : [];
  if (
    /^[a-z0-9]{3,4}$/i.test(term) &&
    !matches.some((n) => n.href === graphHref("company", term.toUpperCase()))
  )
    matches.push({
      name: "Look up ASX:" + term.toUpperCase(),
      detail: "Company register",
      href: graphHref("company", term.toUpperCase()),
    });
  return (
    <form
      className="relative w-full sm:max-w-sm"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (matches[0]) {
          router.push(matches[0].href);
          setQuery("");
        }
      }}
    >
      <label className="flex min-h-11 items-center gap-2 rounded-md border bg-background px-3 text-sm focus-within:ring-2 focus-within:ring-ring">
        <Search
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="sr-only">Search the ownership graph</span>
        <input
          type="search"
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
          }}
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a company, person or holder"
          className="w-full min-w-0 bg-transparent outline-none placeholder:text-muted-foreground placeholder:opacity-100"
        />
      </label>
      {term && (
        <div className="absolute z-30 mt-1 max-h-72 w-full overflow-auto rounded-md border bg-background shadow-sm">
          {matches.length ? (
            <ul aria-label="Graph search results">
              {matches.map((n) => (
                <li key={n.href}>
                  <Link
                    prefetch={false}
                    href={n.href}
                    onClick={() => setQuery("")}
                    className="block border-b px-3 py-2 text-sm last:border-0 hover:bg-muted focus-visible:bg-muted"
                  >
                    <span className="block break-words font-medium">
                      {n.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {n.detail}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p role="status" className="px-3 py-3 text-sm">
              No matching company, person or holder.
            </p>
          )}
        </div>
      )}
    </form>
  );
}
