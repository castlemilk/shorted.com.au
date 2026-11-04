"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { SideSheet } from "~/@/components/gamma/SideSheet";
import { Skeleton } from "~/@/components/gamma/Skeleton";
import { WeightSeries, type WeightPoint } from "../funds/weight-series";
import { safeExternalHref } from "~/@/lib/safe-external-href";
import { cn } from "@/lib/utils";
import { HolderLogo } from "./holder-logo";
import type {
  InspectorContent,
  InspectorLink,
  InspectorQuery,
  InspectorResolver,
  InspectorSection,
} from "./inspector-types";
import { SectorIcon } from "./sector-icon";
import { StockLogoBox } from "./stock-logo-box";
import {
  parseSelection,
  selectionHeading,
  serializeSelection,
  withoutSelection,
  type Selection,
} from "./selection";

/** From `lg` the inspector is the right rail; below it, a sheet from the bottom (spec 14.1). */
const DESKTOP_QUERY = "(min-width: 1024px)";

export interface InspectorProps {
  /** The page's resolver, a server action: maps a selection to plain rows. */
  resolve: InspectorResolver;
  /** The line shown with nothing selected, as the wireframe states it for the page. */
  emptyText: string;
}

/**
 * The inspector (spec 14.1): the aside of the workspace's right rail from `lg`,
 * a SideSheet below it. It reads `?sel=` from the URL and asks the page's resolver
 * for the plain rows of that selection. It reaches no Connect and no generated
 * code: the resolver is the only way in, and it arrives as a prop.
 *
 * The URL read sits under its own Suspense, as `useSearchParams` requires, and
 * the fallback is the page's default view: the empty line, so a static render and
 * the first paint carry the same rail the hydrated one settles on.
 */
export function Inspector(props: InspectorProps) {
  return (
    <Suspense fallback={<InspectorFallback emptyText={props.emptyText} />}>
      <InspectorBody {...props} />
    </Suspense>
  );
}

/** The empty rail, drawn while the URL is read. Nothing is selected yet, so nothing loads. */
export function InspectorFallback({ emptyText }: { emptyText: string }) {
  return (
    <InspectorAside label="Inspector">
      <EmptyPrompt emptyText={emptyText} />
    </InspectorAside>
  );
}

/**
 * The prompt an empty rail shows: its kicker and the prompt, centred in the rail's height (spec 14.9).
 * The fallback and the island draw this one markup, so the rail does not change when the link is read.
 */
function EmptyPrompt({ emptyText }: { emptyText: string }) {
  return (
    <div className="flex h-full flex-col justify-center gap-2">
      <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Inspector</p>
      <p className="text-muted-foreground">{emptyText}</p>
    </div>
  );
}

function InspectorBody({ resolve, emptyText }: InspectorProps) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const params = useSearchParams();
  const search = params?.toString() ?? "";
  const raw = params?.get("sel") ?? "";
  const selection = useMemo(() => parseSelection(raw), [raw]);
  // The link's own parameters the resolver reads (spec 14.8): the lens, the Connections view and the window.
  const query = useMemo<InspectorQuery>(
    () => ({
      lens: params?.get("lens") ?? "",
      view: params?.get("view") ?? "",
      window: params?.get("window") ?? "",
      since: params?.get("since") ?? "",
      until: params?.get("until") ?? "",
      asAt: params?.get("as") ?? "",
    }),
    [params],
  );
  const selectionKey = selection ? serializeSelection(selection) : "";
  // The request is keyed on the selection and the parameters it reads, never the object identity.
  const key = selection
    ? `${selectionKey}|${query.lens}|${query.view}|${query.window}|${query.since}|${query.until}|${query.asAt}`
    : "";
  const clearHref = clearedHref(pathname, search);
  const mobile = useIsMobile();

  // The resolver changes identity on each server render; the request is keyed on
  // the selection alone, so a re-render never asks twice for the same thing.
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{
    key: string;
    content: InspectorContent | null;
    failed: boolean;
  } | null>(null);

  useEffect(() => {
    if (selection === null) return;
    let live = true;
    resolveRef
      .current(selection, query)
      .then((content) => {
        if (live) setLoaded({ key, content, failed: false });
      })
      .catch(() => {
        // A failed read is not an empty record: the rail says so and offers a retry.
        if (live) setLoaded({ key, content: null, failed: true });
      });
    return () => {
      live = false;
    };
    // The selection and the parameters are read through the key: a new object for the same request is the same request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  const current = loaded !== null && loaded.key === key ? loaded : null;
  const content = current?.content ?? null;
  const loading = selection !== null && current === null;
  const failed = current?.failed ?? false;
  const kicker = selection ? selectionHeading(selection) : null;
  // The aside is named by its kind alone until the thing's name arrives.
  const label = content && kicker ? `${kicker} ${content.heading}` : (kicker ?? "Inspector");
  const retry = () => {
    setLoaded(null);
    setAttempt((n) => n + 1);
  };

  // In the sheet the close button is the one "Clear selection", so the body omits its link.
  const body = (inSheet: boolean) => (
    <InspectorBodyContent
      selection={selection}
      loading={loading}
      failed={failed}
      content={content}
      emptyText={emptyText}
      clearHref={clearHref}
      kicker={kicker}
      name={inSheet ? null : (content?.heading ?? null)}
      clearLink={!inSheet}
      onRetry={retry}
    />
  );

  if (mobile) {
    // The sheet's own title names the thing, so the body does not repeat the name.
    return (
      <SideSheet
        side="bottom"
        open={selection !== null}
        onOpenChange={(open) => {
          if (!open) router.replace(clearHref, { scroll: false });
        }}
        title={content?.heading ?? kicker ?? "Inspector"}
        trigger={null}
        closeLabel="Clear selection"
      >
        {body(true)}
      </SideSheet>
    );
  }
  return <InspectorAside label={label}>{body(false)}</InspectorAside>;
}

function InspectorBodyContent({
  selection,
  loading,
  failed,
  content,
  emptyText,
  clearHref,
  kicker,
  name,
  clearLink,
  onRetry,
}: {
  selection: Selection | null;
  loading: boolean;
  failed: boolean;
  content: InspectorContent | null;
  emptyText: string;
  clearHref: string;
  /** The kind of thing selected, in small caps (spec 14.1). */
  kicker: string | null;
  /** The name, in the page-title serif; null when a sheet's title already names it. */
  name: string | null;
  /** False in the sheet, whose close button is the same action. */
  clearLink: boolean;
  onRetry: () => void;
}) {
  // The prompt sits with its kicker, vertically centred in the rail's height (spec 14.9).
  if (selection === null) return <EmptyPrompt emptyText={emptyText} />;
  if (loading) return <InspectorLoading />;
  if (failed) {
    return (
      <div className="space-y-4">
        <p className="text-muted-foreground">Could not load this selection.</p>
        <div className="flex items-center gap-4 text-sm">
          <button type="button" onClick={onRetry} className="underline underline-offset-4">
            Try again
          </button>
          <Link href={clearHref} prefetch={false} scroll={false} className="underline underline-offset-4">
            Clear selection
          </Link>
        </div>
      </div>
    );
  }
  if (content === null) {
    return (
      <div className="space-y-4">
        <p className="text-muted-foreground">Nothing on record for this selection.</p>
        <Link href={clearHref} prefetch={false} scroll={false} className="text-sm underline underline-offset-4">
          Clear selection
        </Link>
      </div>
    );
  }
  const hasName = name !== null;
  const hasLogo = content.logo !== undefined;
  const badges = content.badges ?? [];
  const sections = content.sections ?? [];
  return (
    <div className="space-y-5">
      {kicker !== null || hasName || hasLogo || content.subtitle ? (
        <header className="space-y-2">
          {kicker !== null ? (
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{kicker}</p>
          ) : null}
          {hasName || hasLogo ? (
            <div className="flex items-center gap-3">
              {content.logo ? <InspectorLogoMark logo={content.logo} /> : null}
              {hasName ? (
                <h2 className="min-w-0 font-serif text-3xl font-bold tracking-tight text-balance">{name}</h2>
              ) : null}
            </div>
          ) : null}
          {content.subtitle ? <p className="text-muted-foreground">{content.subtitle}</p> : null}
        </header>
      ) : null}
      {badges.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {badges.map((badge, index) => (
            <li key={`${index}:${badge}`}>
              <span className="rounded-[var(--radius)] border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                {badge}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {content.figure ? (
        <div>
          <p
            className={cn(
              "whitespace-nowrap font-mono text-2xl font-semibold tabular-nums tracking-tight",
              content.figure.tone === "up" && "text-primary",
            )}
          >
            {content.figure.value}
          </p>
          <p className="font-mono text-xs text-muted-foreground">{content.figure.caption}</p>
        </div>
      ) : null}
      {content.rows.length > 0 ? (
        <dl className="divide-y divide-border border-y border-border">
          {content.rows.map((row, index) => (
            <div key={index} className="flex items-baseline justify-between gap-4 py-2">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="text-right font-mono tabular-nums">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {sections.map((section, index) => (
        <InspectorSectionView key={`${index}:${section.title}`} section={section} />
      ))}
      {content.note ? <p className="text-xs text-muted-foreground">{content.note}</p> : null}
      {content.primary ? (
        <Link
          href={content.primary.href}
          prefetch={false}
          className="block w-full rounded-[var(--radius)] bg-primary px-4 py-2.5 text-center font-mono text-sm text-primary-foreground"
        >
          {content.primary.label}
        </Link>
      ) : null}
      {content.links && content.links.length > 0 ? (
        <ul className="space-y-1.5 text-sm">
          {content.links.map((link) => (
            <li key={`${link.label}:${link.href}`}>
              <InspectorLinkText link={link} />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="space-y-2">
        {clearLink ? (
          <Link href={clearHref} prefetch={false} scroll={false} className="block text-sm text-muted-foreground underline underline-offset-4">
            Clear selection
          </Link>
        ) : null}
        {content.footnote ? <p className="text-xs text-muted-foreground">{content.footnote}</p> : null}
      </div>
    </div>
  );
}

/**
 * A link whose parameters are merged into the current link (spec 14.8): the reader's
 * window, lens and selection stay as they are, and only the named parameters change.
 */
function MergedLink({ link, params }: { link: InspectorLink; params: Record<string, string | null> }) {
  const pathname = usePathname() ?? "";
  const search = useSearchParams();
  const next = new URLSearchParams(search?.toString() ?? "");
  for (const [name, value] of Object.entries(params)) {
    if (value === null) next.delete(name);
    else next.set(name, value);
  }
  const query = next.toString();
  return (
    <Link href={query === "" ? pathname : `${pathname}?${query}`} prefetch={false} scroll={false} className="underline underline-offset-4">
      {link.label}
    </Link>
  );
}

/** One titled block of the rail (spec 14.1): rows, a dated series, bars or links. */
function InspectorSectionView({ section }: { section: InspectorSection }) {
  return (
    <section aria-label={section.title} className="space-y-2">
      <h3 className="font-mono text-[11px] text-muted-foreground">{section.title}</h3>
      {section.kind === "series" && section.points && section.points.length > 0 ? (
        <>
          <WeightSeries
            points={section.points.map(
              (point): WeightPoint => ({ asAt: point.label, weightPct: point.read === false ? null : point.value }),
            )}
            label={section.title}
          />
          <dl className="divide-y divide-border border-y border-border">
            {section.items.map((row, index) => (
              <div key={index} className="flex items-baseline justify-between gap-4 py-2">
                <dt className="font-mono text-xs text-muted-foreground">{row.label}</dt>
                <dd className="text-right font-mono tabular-nums">{row.value}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : section.kind === "bars" ? (
        <ul className="space-y-2.5">
          {section.items.map((bar, index) => (
            <li key={index} className="space-y-1" title={bar.title}>
              <div className="flex items-baseline justify-between gap-4">
                {bar.href ? (
                  <Link href={bar.href} prefetch={false} className="min-w-0 truncate underline underline-offset-4">
                    {bar.label}
                  </Link>
                ) : (
                  <span className="min-w-0 truncate">{bar.label}</span>
                )}
                <span className="shrink-0 text-right font-mono tabular-nums">{bar.value}</span>
              </div>
              <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary" style={{ width: `${barPercent(bar.share)}%` }} />
              </div>
            </li>
          ))}
        </ul>
      ) : section.kind === "list" ? (
        <ul className="space-y-1.5 text-sm">
          {section.items.map((link) => (
            <li key={`${link.label}:${link.href}`}>
              <InspectorLinkText link={link} />
            </li>
          ))}
        </ul>
      ) : (
        <dl className="divide-y divide-border border-y border-border">
          {section.items.map((row, index) => (
            <div key={index} className="flex items-baseline justify-between gap-4 py-2">
              <dt className={section.kind === "series" ? "font-mono text-xs text-muted-foreground" : "text-muted-foreground"}>
                {row.label}
              </dt>
              <dd className="text-right font-mono tabular-nums">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function InspectorLinkText({ link }: { link: InspectorLink }) {
  if (link.params) return <MergedLink link={link} params={link.params} />;
  // A stored URL is checked before it is an href (spec 14.7): an unsafe one renders its label as text.
  if (link.external) {
    const href = safeExternalHref(link.href);
    if (href === undefined) return <span>{link.label}</span>;
    return (
      <Link href={href} prefetch={false} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
        {link.label} ↗
      </Link>
    );
  }
  return (
    <Link href={link.href} prefetch={false} rel={link.nofollow ? "nofollow" : undefined} className="underline underline-offset-4">
      {link.label}
    </Link>
  );
}

/** A bar's width in percent: a finite share clamped to 0 to 100, one decimal. */
export function barPercent(share: number): number {
  if (!Number.isFinite(share)) return 0;
  return Math.round(Math.min(1, Math.max(0, share)) * 1000) / 10;
}

function InspectorLogoMark({ logo }: { logo: NonNullable<InspectorContent["logo"]> }) {
  if (logo.kind === "stock") return <StockLogoBox code={logo.code} size={28} />;
  if (logo.kind === "holder") {
    return (
      <HolderLogo
        name={logo.name}
        kind={logo.holderKind}
        website={logo.website}
        holderKey={logo.holderKey}
        size={28}
      />
    );
  }
  return <SectorIcon industry={logo.industry} size={28} />;
}

function InspectorLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading the selection" className="space-y-3">
      <Skeleton height={28} width="60%" />
      <Skeleton height={12} />
      <Skeleton height={12} width="80%" />
    </div>
  );
}

/**
 * The right rail's aside. It is hidden below `lg` by CSS, so a phone never paints
 * it, and the sheet takes over once the viewport is known (no first-paint swap).
 * From `lg` it is a viewport-high column that scrolls within itself (spec 14.9), so the
 * empty prompt centres in the rail and a long selection scrolls under the page's header.
 */
function InspectorAside({ label, children }: { label: string; children: ReactNode }) {
  return (
    <aside aria-label={label} className="sticky top-32 hidden min-w-0 text-sm lg:block lg:h-[calc(100vh-8rem)] lg:overflow-y-auto">
      {children}
    </aside>
  );
}

/** The current URL with the selection cleared; the path alone when nothing else is set. */
function clearedHref(pathname: string, search: string): string {
  const rest = withoutSelection(search);
  return rest === "" ? pathname : `${pathname}?${rest}`;
}

/**
 * Whether the viewport is below `lg`, read after mount. The default is the rail
 * (false), so the server and the first paint never draw the sheet open.
 */
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
