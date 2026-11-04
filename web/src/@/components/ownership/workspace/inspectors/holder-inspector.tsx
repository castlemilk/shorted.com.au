"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { SideSheet } from "~/@/components/gamma/SideSheet";
import { Skeleton } from "~/@/components/gamma/Skeleton";
import { KindBadge } from "~/@/components/ownership/kind-badge";
import { fundHref } from "~/@/lib/ownership/kinds";
import { fundLabel } from "../../funds/fund-model";
import {
  HOLDER_PARAM,
  fundSizeLabel,
  resolveHolderKey,
  withSearch,
  type HolderFundRow,
  type HolderInspectorContent,
} from "~/@/components/ownership/holders/holder-tree";
import { cn } from "@/lib/utils";
import { HolderLogo } from "../holder-logo";
import type { InspectorLink, InspectorSection } from "../inspector-types";
import { WeekStrip } from "../week-strip-view";

/** From `lg` the holder inspector is the right rail; below it, a sheet (spec 14.1). */
const DESKTOP_QUERY = "(min-width: 1024px)";

export interface HolderInspectorProps {
  /** The holder shown with nothing else selected: its content, read on the server. */
  initial: HolderInspectorContent | null;
  /** The holder shown when the URL names none. */
  defaultKey: string;
  /** A page that shows one holder pins it and ignores `?holder=`. */
  fixedKey?: string;
  /** Reads a holder's inspector content for a selection (a server action). */
  resolve: (key: string, selection: string) => Promise<HolderInspectorContent | null>;
}

type DetailTab = "disclosed" | "funds";

/**
 * The holder inspector (spec 14.3, Holders; 14.1): the right rail of a holder's
 * page, the holder's logo, name, kind and disclosed positions, the Disclosed
 * interests and Funds & products tabs, and the selected connection from `?sel=`.
 * It always shows a holder, so it is not the generic Inspector, which waits for a
 * selection. From `lg` it is the rail; below it, a SideSheet opens when something
 * is selected and closes with its button or Escape.
 *
 * The URL is read under a Suspense boundary. The fallback is the initial holder.
 * The holder comes from `resolveHolderKey`, the one rule the map and the browser use.
 */
export function HolderInspector(props: HolderInspectorProps) {
  const fallbackKey = props.fixedKey ?? props.defaultKey;
  return (
    <Suspense fallback={<InspectorBody {...props} requested={fallbackKey} selection="" />}>
      <InspectorReader {...props} />
    </Suspense>
  );
}

function InspectorReader(props: HolderInspectorProps) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const params = useSearchParams();
  const search = params?.toString() ?? "";
  const requested = props.fixedKey ?? resolveHolderKey(params?.get(HOLDER_PARAM), props.defaultKey);
  const selection = params?.get("sel") ?? "";
  const onClear = () => {
    router.replace(withSearch(pathname, search, { sel: null }), { scroll: false });
  };
  return <InspectorBody {...props} requested={requested} selection={selection} onClear={onClear} />;
}

function InspectorBody({
  initial,
  defaultKey,
  fixedKey,
  requested,
  selection,
  resolve,
  onClear,
}: HolderInspectorProps & { requested: string; selection: string; onClear?: () => void }) {
  // The initial content is for the default holder with nothing selected; every other view is read.
  const usesInitial = requested === defaultKey && selection === "";
  const [loaded, setLoaded] = useState<{ key: string; sel: string; content: HolderInspectorContent | null } | null>(
    null,
  );
  useEffect(() => {
    if (usesInitial) return;
    let live = true;
    resolve(requested, selection)
      .then((content) => {
        if (live) setLoaded({ key: requested, sel: selection, content });
      })
      .catch(() => {
        if (live) setLoaded({ key: requested, sel: selection, content: null });
      });
    return () => {
      live = false;
    };
    // The resolver is read through its arguments; a new function for the same request is the same read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested, selection, usesInitial]);

  const current =
    usesInitial ? { content: initial } : loaded && loaded.key === requested && loaded.sel === selection ? loaded : null;
  const content = current?.content ?? null;
  const pinned = fixedKey !== undefined;
  const mobile = useIsMobile();
  // Below lg a pick opens the sheet too: a holder pick clears the selection, so the sheet
  // would otherwise never open until a company is selected. Closing it stays closed until
  // the next pick or selection.
  const [sheetOpen, setSheetOpen] = useState(false);
  const shownKey = useRef(requested);
  useEffect(() => {
    if (selection !== "") setSheetOpen(true);
  }, [selection]);
  useEffect(() => {
    if (shownKey.current === requested) return;
    shownKey.current = requested;
    setSheetOpen(true);
  }, [requested]);

  // A new selection on the same holder keeps the content on screen until it resolves; the
  // rail does not drop to a skeleton on every map click.
  const lastShown = useRef<{ key: string; content: HolderInspectorContent } | null>(null);
  useEffect(() => {
    if (content !== null) lastShown.current = { key: requested, content };
  }, [content, requested]);
  const held = current === null && lastShown.current?.key === requested ? lastShown.current.content : null;

  // Clear selection is the connections map's footer control (the wireframe's); the rail has none.
  const body =
    current === null && held === null ? (
      <div role="status" aria-busy="true" aria-label="Loading the holder" className="space-y-3">
        <Skeleton height={28} width="60%" />
        <Skeleton height={12} />
        <Skeleton height={12} width="80%" />
      </div>
    ) : current === null && held !== null ? (
      <div aria-busy="true">
        <HolderContent key={held.heading} content={held} pinned={pinned} />
      </div>
    ) : content === null ? (
      <p className="text-muted-foreground">
        This holder is not listed, or could not be read just now.
      </p>
    ) : (
      <HolderContent key={content.heading} content={content} pinned={pinned} />
    );

  if (mobile) {
    // Below lg the content is a sheet, open while a selection is in the URL.
    return (
      <SideSheet
        open={sheetOpen}
        onOpenChange={(open) => {
          if (open) return;
          setSheetOpen(false);
          onClear?.();
        }}
        title={content?.heading ?? "Selected holder"}
        trigger={null}
        closeLabel="Clear selection"
      >
        {body}
      </SideSheet>
    );
  }
  return (
    // Hidden below lg by CSS, so a phone never paints the rail: the sheet is the phone's inspector.
    <aside aria-label="Selected holder" className="sticky top-32 hidden min-w-0 text-sm lg:block">
      {body}
    </aside>
  );
}

/** Whether the page is at lg or wider. Starts false, so the static HTML is the rail. */
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(DESKTOP_QUERY);
    const sync = () => setMobile(!media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return mobile;
}

function HolderContent({ content, pinned }: { content: HolderInspectorContent; pinned: boolean }) {
  const [tab, setTab] = useState<DetailTab>("disclosed");
  const logo = content.logo;
  const holderKind = logo?.kind === "holder" ? logo.holderKind : "";
  // A pinned page is the holder's own profile: its primary action points at the section beneath it.
  const primary = pinned ? { label: "Substantial holdings →", href: "#stakes" } : content.primary;
  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Selected holder</p>
        <div className="flex items-center gap-3">
          {logo?.kind === "holder" ? (
            <HolderLogo
              name={logo.name}
              kind={logo.holderKind}
              website={logo.website}
              holderKey={logo.holderKey}
              size={28}
            />
          ) : null}
          <h2 className="min-w-0 font-serif text-3xl font-bold tracking-tight text-balance">{content.heading}</h2>
        </div>
        {holderKind ? <KindBadge kind={holderKind} /> : null}
        {content.summary && content.summary.length > 0 ? (
          <ul className="space-y-0.5 text-muted-foreground">
            {content.summary.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
      </header>
      {content.reading ? <p className="text-sm leading-snug text-foreground">{content.reading}</p> : null}
      {content.rows.length > 0 ? (
        <dl className="divide-y divide-border border-y border-border">
          {content.rows.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-4 py-2">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="text-right font-mono tabular-nums">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {/* Underlined text tabs (spec 14.9): the two tabs fit the rail on one line of text. */}
      <div role="tablist" aria-label="Holder detail" className="flex gap-5 border-b border-border text-sm">
        {(
          [
            { value: "disclosed", label: "Disclosed interests" },
            { value: "funds", label: "Funds & products" },
          ] as const
        ).map((option) => {
          const on = tab === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setTab(option.value)}
              className={cn(
                "-mb-px whitespace-nowrap border-b-2 pb-2 transition-colors",
                on ? "border-primary font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {content.footnote ? <p className="text-xs text-muted-foreground">{content.footnote}</p> : null}
      {tab === "disclosed" ? <DisclosedInterests content={content} /> : <FundsAndProducts funds={content.funds} />}
      {primary ? (
        <Link
          href={primary.href}
          prefetch={false}
          className="block w-full rounded-[var(--radius)] bg-primary px-4 py-2.5 text-center font-mono text-sm text-primary-foreground"
        >
          {primary.label}
        </Link>
      ) : null}
      {content.links && content.links.length > 0 ? (
        <ul className="space-y-1.5 text-sm">
          {content.links.map((link) => (
            <li key={`${link.label}:${link.href}`}>
              <HolderLinkText link={link} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function DisclosedInterests({ content }: { content: HolderInspectorContent }) {
  const sections = content.sections ?? [];
  return (
    <div className="space-y-5">
      {content.selectionHeading ? <h3 className="text-sm font-medium">{content.selectionHeading}</h3> : null}
      {sections.map((section) => (
        <HolderSection key={section.title} section={section} />
      ))}
      {content.connectionLink ? (
        <p className="text-sm">
          <HolderLinkText link={content.connectionLink} />
        </p>
      ) : null}
      {content.note ? <p className="text-xs text-muted-foreground">{content.note}</p> : null}
    </div>
  );
}

function FundsAndProducts({ funds }: { funds: HolderFundRow[] }) {
  if (funds.length === 0) {
    return <p className="text-sm text-muted-foreground">No index fund or super option file is tracked for this holder.</p>;
  }
  return (
    <ul className="divide-y divide-border border-y border-border">
      {funds.map((fund) => (
        <li key={fund.key} className="flex items-baseline justify-between gap-4 py-2">
          <Link
            href={fundHref(fund.key)}
            prefetch={false}
            title={fund.name}
            className="min-w-0 truncate underline underline-offset-4"
          >
            {fundLabel({ ticker: fund.asxCode, name: fund.name })}
          </Link>
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{fundSizeLabel(fund)}</span>
        </li>
      ))}
    </ul>
  );
}

function HolderSection({ section }: { section: InspectorSection }) {
  return (
    <section aria-label={section.title} className="space-y-2">
      <h3 className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{section.title}</h3>
      {section.kind === "weeks" ? (
        <WeekStrip weeks={section.weeks} label={section.title} />
      ) : section.kind === "bars" ? (
        <ul className="space-y-2.5">
          {section.items.map((bar) => (
            <li key={bar.label} className="space-y-1">
              <div className="flex items-baseline justify-between gap-4">
                <span className="min-w-0 truncate">{bar.label}</span>
                <span className="shrink-0 text-right font-mono tabular-nums">{bar.value}</span>
              </div>
              <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.round(Math.min(1, Math.max(0, bar.share)) * 1000) / 10}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      ) : section.kind === "list" ? (
        <ul className="space-y-1.5 text-sm">
          {section.items.map((link) => (
            <li key={`${link.label}:${link.href}`}>
              <HolderLinkText link={link} />
            </li>
          ))}
        </ul>
      ) : (
        <dl className="divide-y divide-border border-y border-border">
          {section.items.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-4 py-2">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className={cn("text-right font-mono tabular-nums", row.value === "n/a" && "text-muted-foreground")}>
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function HolderLinkText({ link }: { link: InspectorLink }) {
  // A stored URL that is not safe keeps its label as text (spec 14.7): no href, no link.
  if (link.href === "") return <span>{link.label}</span>;
  return (
    <Link
      href={link.href}
      prefetch={false}
      {...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className="underline underline-offset-4"
    >
      {link.label}
      {link.external ? " ↗" : null}
    </Link>
  );
}
