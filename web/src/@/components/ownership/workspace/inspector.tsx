"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { SideSheet } from "~/@/components/gamma/SideSheet";
import { Skeleton } from "~/@/components/gamma/Skeleton";
import { WeightSeries, type WeightPoint } from "../funds/weight-series";
import { parseFundKeys } from "../funds/fund-model";
import { safeExternalHref } from "~/@/lib/safe-external-href";
import { cn } from "@/lib/utils";
import { HolderLogo } from "./holder-logo";
import type {
  InspectorContent,
  InspectorLink,
  InspectorQuery,
  InspectorResolver,
  InspectorSection,
  LargestMovesBlock,
} from "./inspector-types";
import { shortSector } from "~/@/lib/ownership/kinds";
import { zoomedSector } from "./nav";
import { SectorIcon } from "./sector-icon";
import { StockLogoBox } from "./stock-logo-box";
import { WeekStrip } from "./week-strip-view";
import { pushTrail, readTrail, trailHref, trailKey, writeTrail, type TrailStep, type TrailStorage } from "./trail";
import {
  compareSelection,
  parseSelection,
  sectorSelection,
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
  /**
   * The empty rail's list beneath the line, when the page has one (the Activity page's largest
   * moves, spec 14.10). Absent or null draws the line alone.
   */
  largestMoves?: LargestMovesBlock | null;
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
    <Suspense fallback={<InspectorFallback emptyText={props.emptyText} largestMoves={props.largestMoves} />}>
      <InspectorBody {...props} />
    </Suspense>
  );
}

/** The empty rail, drawn while the URL is read. Nothing is selected yet, so nothing loads. */
export function InspectorFallback({ emptyText, largestMoves }: { emptyText: string; largestMoves?: LargestMovesBlock | null }) {
  return (
    <InspectorAside label="Inspector">
      <EmptyPrompt emptyText={emptyText} largestMoves={largestMoves} />
    </InspectorAside>
  );
}

/**
 * The prompt an empty rail shows: its kicker and the prompt, centred in the rail's height (spec 14.9).
 * The fallback and the island draw this one markup, so the rail does not change when the link is read.
 */
function EmptyPrompt({
  emptyText,
  largestMoves,
  trail,
  currentHref,
}: {
  emptyText: string;
  largestMoves?: LargestMovesBlock | null;
  trail?: TrailStep[];
  currentHref?: string;
}) {
  return (
    <div className="flex h-full flex-col justify-center gap-2">
      {trail && trail.length > 0 ? <TrailNav steps={trail} currentHref={currentHref ?? null} /> : null}
      <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Inspector</p>
      <p className="text-muted-foreground">{emptyText}</p>
      {largestMoves ? <LargestMoves block={largestMoves} /> : null}
    </div>
  );
}

/**
 * "Largest moves in the window" (spec 14.10): the notices that state the largest change, each
 * with its change and a link to the notice. An empty list says no notice states a change, so
 * the heading is never drawn over nothing.
 */
function LargestMoves({ block }: { block: LargestMovesBlock }) {
  return (
    <section aria-labelledby="largest-moves" className="mt-4 space-y-2">
      <h2 id="largest-moves" className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
        Largest moves, every holder type, last {block.windowDays} days
      </h2>
      {block.from !== "" ? (
        <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
          Notices released {block.from} to {block.to}
        </p>
      ) : null}
      {block.lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {block.from !== "" ? `No notice from ${block.from} to ${block.to} states a change.` : `No notice in the last ${block.windowDays} days states a change.`}
        </p>
      ) : (
        <ol className="space-y-2 text-sm">
          {/* Two lines per move: the company and holder, then the change and its date, so the holder's name is never cut for the figure. */}
          {block.lines.map((line, index) => (
            <li key={`${index}:${line.label}`} className="flex min-w-0 flex-col gap-0.5">
              {line.href ? (
                <a href={line.href} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate underline underline-offset-4" title={line.label}>
                  {line.label}
                </a>
              ) : (
                <span className="min-w-0 truncate" title={line.label}>{line.label}</span>
              )}
              <span className="font-mono text-xs tabular-nums text-muted-foreground">{line.value}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function InspectorBody({ resolve, emptyText, largestMoves }: InspectorProps) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const params = useSearchParams();
  const search = params?.toString() ?? "";
  const raw = params?.get("sel") ?? "";
  const linked = useMemo(() => parseSelection(raw), [raw]);
  // Two ticked funds (backlog C5) are the selection when the link names none: a comparison of exactly two funds.
  // One key alone is no comparison, and a key the codec would not write (compareSelection) is none either.
  const fundsRaw = params?.get("funds") ?? "";
  const comparison = useMemo<Selection | null>(
    () => (linked === null ? compareSelection(parseFundKeys(fundsRaw)) : null),
    [linked, fundsRaw],
  );
  // The zoomed sector (backlog C4) is the selection when the link names none: a selection wins over both.
  const sector = zoomedSector(params?.get("sector"));
  const selection = useMemo<Selection | null>(
    () => linked ?? comparison ?? sectorSelection(sector),
    [linked, comparison, sector],
  );
  // The link's own parameters the resolver reads (spec 14.8): the lens, the Connections view and the window.
  const query = useMemo<InspectorQuery>(
    () => ({
      lens: params?.get("lens") ?? "",
      view: params?.get("view") ?? "",
      window: params?.get("window") ?? "",
      since: params?.get("since") ?? "",
      until: params?.get("until") ?? "",
      asAt: params?.get("as") ?? "",
      from: params?.get("from") ?? "",
      to: params?.get("to") ?? "",
    }),
    [params],
  );
  const selectionKey = selection ? serializeSelection(selection) : "";
  // The request is keyed on the selection and the parameters it reads, never the object identity.
  const key = selection
    ? `${selectionKey}|${query.lens}|${query.view}|${query.window}|${query.since}|${query.until}|${query.asAt}|${query.from}|${query.to}`
    : "";
  // Clear selection on a comparison clears the ticked funds; on a zoomed sector it clears the zoom itself. Either
  // leaves the rest of the link as it is, so a sector zoomed under a comparison is still the map's zoom.
  const clearHref =
    linked !== null
      ? clearedHref(pathname, search)
      : comparison !== null
        ? clearedParamHref(pathname, search, "funds")
        : sector !== ""
          ? clearedParamHref(pathname, search, "sector")
          : clearedHref(pathname, search);
  // The link that restores the page as it is now: the trail's current step is the one that matches it.
  const pageHref = trailHref(pathname, search);
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
  // The trail's sector step is the zoom with no link selection; a selected sector is the resolved selection's own step.
  const trail = useInspectorTrail({
    pathname,
    href: pageHref,
    hasSelection: linked !== null,
    selectionKey: linked ? serializeSelection(linked) : "",
    selectionKind: linked ? selectionHeading(linked) : "",
    sector,
    heading: content?.heading ?? null,
  });
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
      largestMoves={largestMoves}
      clearHref={clearHref}
      kicker={kicker}
      name={inSheet ? null : (content?.heading ?? null)}
      clearLink={!inSheet}
      onRetry={retry}
      trail={trail}
      currentHref={pageHref}
    />
  );

  if (mobile) {
    // The sheet's own title names the thing, so the body does not repeat the name. It opens on the link's own
    // selection and on a comparison of two ticked funds, which has no other surface below lg. A zoomed sector stays
    // closed: it is the map's state, and a sheet over it would hide the zoom the tap asked for.
    return (
      <SideSheet
        side="bottom"
        open={linked !== null || comparison !== null}
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
  largestMoves,
  clearHref,
  kicker,
  name,
  clearLink,
  onRetry,
  trail,
  currentHref,
}: {
  selection: Selection | null;
  loading: boolean;
  failed: boolean;
  content: InspectorContent | null;
  emptyText: string;
  largestMoves?: LargestMovesBlock | null;
  clearHref: string;
  /** The kind of thing selected, in small caps (spec 14.1). */
  kicker: string | null;
  /** The name, in the page-title serif; null when a sheet's title already names it. */
  name: string | null;
  /** False in the sheet, whose close button is the same action. */
  clearLink: boolean;
  onRetry: () => void;
  /** The page's trail (backlog C2), drawn above everything in the rail. */
  trail: TrailStep[];
  /** The link that restores the page as it is now; the trail's step with this link is the current one. */
  currentHref: string;
}) {
  const trailNav = trail.length > 0 ? <TrailNav steps={trail} currentHref={currentHref} /> : null;
  // The prompt sits with its kicker, vertically centred in the rail's height (spec 14.9).
  if (selection === null) {
    return <EmptyPrompt emptyText={emptyText} largestMoves={largestMoves} trail={trail} currentHref={currentHref} />;
  }
  if (loading) {
    return (
      <div className="space-y-5">
        {trailNav}
        <InspectorLoading />
      </div>
    );
  }
  if (failed) {
    return (
      <div className="space-y-4">
        {trailNav}
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
        {trailNav}
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
  // The primary action sits where the resolver placed it: after every section by default, or before them (C7).
  const primary = content.primary ? (
    <Link
      href={content.primary.href}
      prefetch={false}
      rel={content.primary.nofollow ? "nofollow" : undefined}
      className="block w-full rounded-[var(--radius)] bg-primary px-4 py-2.5 text-center font-mono text-sm text-primary-foreground"
    >
      {content.primary.label}
    </Link>
  ) : null;
  const primaryFirst = content.primaryPlacement === "first";
  return (
    <div className="space-y-5">
      {trailNav}
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
      {content.reading ? <p className="text-sm leading-snug text-foreground">{content.reading}</p> : null}
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
      {primaryFirst ? primary : null}
      {sections.map((section, index) => (
        <InspectorSectionView key={`${index}:${section.title}`} section={section} />
      ))}
      {content.note ? <p className="text-xs text-muted-foreground">{content.note}</p> : null}
      {primaryFirst ? null : primary}
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
function MergedLink({
  link,
  params,
  className = "underline underline-offset-4",
}: {
  link: Pick<InspectorLink, "label">;
  params: Record<string, string | null>;
  className?: string;
}) {
  const pathname = usePathname() ?? "";
  const search = useSearchParams();
  const next = new URLSearchParams(search?.toString() ?? "");
  for (const [name, value] of Object.entries(params)) {
    if (value === null) next.delete(name);
    else next.set(name, value);
  }
  const query = next.toString();
  return (
    <Link href={query === "" ? pathname : `${pathname}?${query}`} prefetch={false} scroll={false} className={className}>
      {link.label}
    </Link>
  );
}

/** One titled block of the rail (spec 14.1): rows, a dated series, bars or links. */
function InspectorSectionView({ section }: { section: InspectorSection }) {
  return (
    <section aria-label={section.title} className="space-y-2">
      <h3 className="font-mono text-[11px] text-muted-foreground">{section.title}</h3>
      {section.kind === "weeks" ? (
        <WeekStrip weeks={section.weeks} label={section.title} />
      ) : section.kind === "series" && section.points && section.points.length > 0 ? (
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
                {bar.params ? (
                  <MergedLink link={{ label: bar.label }} params={bar.params} className="min-w-0 truncate underline underline-offset-4" />
                ) : bar.href ? (
                  <Link href={bar.href} prefetch={false} className="min-w-0 truncate underline underline-offset-4">
                    {bar.label}
                  </Link>
                ) : (
                  <span className="min-w-0 truncate">{bar.label}</span>
                )}
                <span className="shrink-0 text-right font-mono tabular-nums">{bar.value}</span>
              </div>
              {bar.detail ? <p className="text-xs text-muted-foreground">{bar.detail}</p> : null}
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
 * The trail (spec 14.1, backlog C2): the steps the reader has taken on this page, each as a link
 * that restores it, except the step that matches the page as it is now, which is the current one
 * in the foreground. Mono and small, with " > " between steps. After "Clear selection" the trail
 * is kept and no step is current, so every step stays a way back.
 */
function TrailNav({ steps, currentHref }: { steps: TrailStep[]; currentHref: string | null }) {
  return (
    <nav aria-label="Trail" className="font-mono text-xs text-muted-foreground">
      <p className="break-words leading-relaxed">
        {steps.map((step, index) => {
          const current = step.href === currentHref;
          return (
            <Fragment key={`${index}:${step.href}`}>
              {index > 0 ? " > " : null}
              {current ? (
                <span aria-current="step" className="text-foreground">
                  {step.label}
                </span>
              ) : (
                <Link
                  href={step.href}
                  prefetch={false}
                  scroll={false}
                  className="inline-flex min-h-[24px] items-center underline underline-offset-4 hover:text-foreground"
                >
                  {step.label}
                </Link>
              )}
            </Fragment>
          );
        })}
      </p>
    </nav>
  );
}

/** The browser's sessionStorage, or null where it is absent or refused (a privacy mode that throws). */
function sessionStore(): TrailStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * The page's trail, kept in sessionStorage under the page's path (backlog C2). The stored trail is
 * read after mount, so the server and the first paint carry none. A step is recorded once per
 * selection: when a selection's content arrives, or, with no selection, when a sector is zoomed.
 * A change of the lens or the window on the same selection is not a new step.
 */
function useInspectorTrail({
  pathname,
  href,
  hasSelection,
  selectionKey,
  selectionKind,
  sector,
  heading,
}: {
  pathname: string;
  /** The link that restores the page as it is now. */
  href: string;
  hasSelection: boolean;
  selectionKey: string;
  /** The kind of thing selected, named when the content has no heading to take its place. */
  selectionKind: string;
  sector: string;
  /** The resolved content's heading; null while the selection loads or when it failed. */
  heading: string | null;
}): TrailStep[] {
  const key = trailKey(pathname);
  const [store, setStore] = useState<{ key: string; steps: TrailStep[] } | null>(null);
  const hrefRef = useRef(href);
  hrefRef.current = href;
  const recorded = useRef<{ key: string; id: string } | null>(null);

  // Read after mount: the first render is the server's, with no trail.
  useEffect(() => {
    setStore({ key, steps: readTrail(sessionStore(), key) });
  }, [key]);

  useEffect(() => {
    let label: string;
    let id: string;
    if (hasSelection) {
      // A failed or still loading selection is not a step yet.
      if (heading === null) return;
      label = heading.trim() === "" ? selectionKind : heading;
      id = `sel:${selectionKey}`;
    } else if (sector !== "") {
      label = shortSector(sector);
      id = `sector:${sector}`;
    } else {
      return;
    }
    if (recorded.current !== null && recorded.current.key === key && recorded.current.id === id) return;
    recorded.current = { key, id };
    const storage = sessionStore();
    const step: TrailStep = { label, href: hrefRef.current };
    // The write is idempotent (the same trail under the same key), so a second run of this updater is harmless.
    setStore((prev) => {
      const base = prev !== null && prev.key === key ? prev.steps : readTrail(storage, key);
      // Clear selection on a zoomed sector lands on that sector's own link. That is the reader's place
      // returning, not a new step: the trail after it (the company, the holder) stays walkable.
      if (!hasSelection && base.some((existing) => existing.href === step.href)) return { key, steps: base };
      const steps = pushTrail(base, step);
      writeTrail(storage, key, steps);
      return { key, steps };
    });
  }, [key, hasSelection, selectionKey, selectionKind, sector, heading]);

  return store !== null && store.key === key ? store.steps : [];
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

/** The current URL with one parameter cleared (the zoomed sector, backlog C4; the ticked funds, C5) and every other kept. */
function clearedParamHref(pathname: string, search: string, name: string): string {
  const params = new URLSearchParams(search);
  params.delete(name);
  const rest = params.toString();
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
