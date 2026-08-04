"use client";

import React from "react";
import Link from "next/link";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { type ReportCitation } from "~/app/actions/reports/getReportData";
import {
  CitationPill,
  CitationSources,
  MARKER_PATTERN,
  type TakeCitation,
} from "./citations";
import { DROP_CAP_FIRST_LETTER, firstProseBlockIndex } from "./drop-cap";

export type { TakeCitation } from "./citations";

export interface TakeInlineImage {
  url: string;
  topic?: string;
  alt?: string;
}

export interface TakeLayoutImage {
  url: string;
  style?: string;
  /** "landscape" | "portrait" | "square" */
  ratio: string;
  brief?: string;
  caption?: string;
  /** "full" | "left" | "right" | "inset" */
  placement: string;
  anchorAfterBlock: number;
}

interface TakeBodyProps {
  bodyMd: string;
  citations: TakeCitation[];
  inlineImages?: TakeInlineImage[];
  layoutImages?: TakeLayoutImage[];
  stockCode?: string;
}

// Citation markers ([ref-N] / [report-N]) collide with markdown link
// syntax, so before handing the body to the markdown parser we escape
// them to a sentinel ({{ref-N}}) that survives parsing untouched, then
// turn the sentinel back into a citation pill while rendering inline text.
const CODE_PATTERN = /\b([A-Z]{2,4})\b/g;
const SENTINEL_SPLIT = /(«cite:(?:ref|report)-\d+»)/g;
const SENTINEL_MATCH = /^«cite:(ref|report)-(\d+)»$/;

function escapeMarkers(md: string): string {
  return md.replace(MARKER_PATTERN, (_m, id: string) => `«cite:${id}»`);
}

/** Render a plain string: citation sentinels → pills, bare stock codes → links. */
function renderInlineString(
  str: string,
  citationMap: Map<string, ReportCitation>,
  codeSet: Set<string>,
  keyBase: string,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  str.split(SENTINEL_SPLIT).forEach((part, pi) => {
    if (!part) return;
    const m = SENTINEL_MATCH.exec(part);
    if (m) {
      const kind = m[1];
      const num = m[2]!;
      const refId = `${kind}-${num}`;
      const citation = citationMap.get(refId);
      // Shared pill renderer (citations.tsx) — derives kind/number from the
      // refId and falls back to literal "[ref-N]" when the citation is unknown.
      out.push(<CitationPill key={`${keyBase}-c${pi}`} refId={refId} citation={citation} />);
      return;
    }
    // Plain text — auto-link known stock codes.
    CODE_PATTERN.lastIndex = 0;
    let lastEnd = 0;
    let match: RegExpExecArray | null;
    let i = 0;
    while ((match = CODE_PATTERN.exec(part)) !== null) {
      const code = match[1]!;
      if (!codeSet.has(code)) continue;
      if (match.index > lastEnd) {
        out.push(<span key={`${keyBase}-${pi}-t${i++}`}>{part.slice(lastEnd, match.index)}</span>);
      }
      out.push(
        <Link
          key={`${keyBase}-${pi}-l${i++}`}
          href={`/shorts/${code}`}
          prefetch={false}
          className="font-semibold text-primary underline-offset-2 hover:underline"
        >
          {code}
        </Link>,
      );
      lastEnd = match.index + code.length;
    }
    if (lastEnd < part.length) {
      out.push(<span key={`${keyBase}-${pi}-t${i++}`}>{part.slice(lastEnd)}</span>);
    }
  });
  return out;
}

/** Apply the inline transform to a node tree's string children (recursing
 *  into nested markdown elements like <strong>/<em> is handled because
 *  those elements re-enter their own component override). */
function linkify(
  children: React.ReactNode,
  citationMap: Map<string, ReportCitation>,
  codeSet: Set<string>,
): React.ReactNode {
  return React.Children.map(children, (child, i) => {
    if (typeof child === "string") {
      return renderInlineString(child, citationMap, codeSet, `n${i}`);
    }
    return child;
  });
}

function buildComponents(
  citationMap: Map<string, ReportCitation>,
  codeSet: Set<string>,
  dropCap = false,
): Components {
  const inline = (children: React.ReactNode) => linkify(children, citationMap, codeSet);
  const pClass = dropCap
    ? `text-foreground/90 ${DROP_CAP_FIRST_LETTER}`
    : "text-foreground/90";
  return {
    h1: ({ children }) => <h2 className="mb-2 mt-8 text-2xl font-bold tracking-tight text-foreground">{inline(children)}</h2>,
    h2: ({ children }) => <h2 className="mb-2 mt-8 text-xl font-bold tracking-tight text-foreground">{inline(children)}</h2>,
    h3: ({ children }) => <h3 className="mb-1.5 mt-6 text-lg font-semibold tracking-tight text-foreground">{inline(children)}</h3>,
    h4: ({ children }) => <h4 className="mb-1 mt-4 text-base font-semibold text-foreground">{inline(children)}</h4>,
    p: ({ children }) => <p className={pClass}>{inline(children)}</p>,
    ul: ({ children }) => <ul className="ml-5 list-disc space-y-1 text-foreground/90">{children}</ul>,
    ol: ({ children }) => <ol className="ml-5 list-decimal space-y-1 text-foreground/90">{children}</ol>,
    li: ({ children }) => <li>{inline(children)}</li>,
    strong: ({ children }) => <strong className="font-semibold text-foreground">{inline(children)}</strong>,
    em: ({ children }) => <em>{inline(children)}</em>,
    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-orange-400/50 pl-4 italic text-foreground/80">{children}</blockquote>
    ),
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">
        {children}
      </a>
    ),
    code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">{children}</code>,
    hr: () => <hr className="my-6 border-border" />,
  };
}

function aspectClass(ratio: string): string {
  if (ratio === "portrait") return "aspect-[2/3]";
  if (ratio === "square") return "aspect-square";
  return "aspect-[3/2]"; // landscape
}

/**
 * Renders an editorial Take body as markdown (headings, lists, emphasis,
 * blockquotes, …) with inline [ref-N] citation pills and auto-linked
 * stock codes preserved. The body is split on blank lines into blocks so
 * inline images can be woven between them; each block is rendered with
 * react-markdown. The Sources list renders below, keyed by ref id.
 */
export function TakeBody({ bodyMd, citations, inlineImages = [], layoutImages, stockCode }: TakeBodyProps) {
  const blocks = bodyMd.split(/\n\s*\n/).filter((b) => b.trim().length > 0);
  const useLayout = (layoutImages?.length ?? 0) > 0;

  // LinkifiedNarrative-style citation lookup (ReportCitation shape).
  const citationMap = new Map<string, ReportCitation>();
  for (const c of citations) {
    citationMap.set(c.refId, { id: c.refId, source: c.source, date: c.date, url: c.url, type: c.type } as ReportCitation);
  }
  const codeSet = new Set((stockCode ? [stockCode] : []).map((c) => c.toUpperCase()));
  const components = buildComponents(citationMap, codeSet);
  // Drop cap on the first prose paragraph — applied via the p override of
  // the block that actually holds it (bodies often open with a heading,
  // and the layout path wraps blocks in divs, so container-level CSS
  // selectors can't find it reliably).
  const firstProseIdx = firstProseBlockIndex(blocks);
  const dropCapComponents = buildComponents(citationMap, codeSet, true);
  const componentsFor = (k: number) =>
    k === firstProseIdx ? dropCapComponents : components;

  // --- Magazine layout weaving (art-directed layoutImages) ---------------
  // Classify each layout image: full-bleed (wide break) vs side-pair
  // (the primary alternating text|image magazine pattern).
  const fullAfter = new Map<number, TakeLayoutImage>(); // full-bleed after block N
  const pairAt = new Map<number, TakeLayoutImage>(); // side-by-side paired with block N
  if (useLayout) {
    for (const li of layoutImages!) {
      const anchor = Math.min(Math.max(0, li.anchorAfterBlock ?? 0), blocks.length - 1);
      const isFull = li.placement === "full" || li.ratio === "landscape";
      if (isFull) fullAfter.set(anchor, li);
      else if (!pairAt.has(anchor)) pairAt.set(anchor, li);
      else fullAfter.set(anchor, li); // overflow: a second image at same anchor goes full
    }
  }

  const isHeading = (b: string) => /^#{2,4}\s/.test(b.trim());

  const layoutImg = (li: TakeLayoutImage) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={li.url}
      alt={li.caption ?? li.brief ?? "Editorial illustration"}
      className={`w-full ${aspectClass(li.ratio)} object-cover`}
      loading="lazy"
      decoding="async"
    />
  );

  const bodyNodes: React.ReactNode[] = [];
  if (useLayout) {
    const consumed = new Set<number>();
    let pairCount = 0;
    for (let i = 0; i < blocks.length; i++) {
      if (consumed.has(i)) continue;
      const mdFor = (idx: number | number[]) => {
        const arr = Array.isArray(idx) ? idx : [idx];
        return arr.map((k) => (
          <ReactMarkdown key={`md-${k}`} remarkPlugins={[remarkGfm]} components={componentsFor(k)}>
            {escapeMarkers(blocks[k]!)}
          </ReactMarkdown>
        ));
      };

      if (pairAt.has(i)) {
        const li = pairAt.get(i)!;
        // Text column = this block; if it's a heading, also pull in the next prose block.
        const textIdx = [i];
        if (
          isHeading(blocks[i]!) &&
          i + 1 < blocks.length &&
          !pairAt.has(i + 1) &&
          !fullAfter.has(i + 1) &&
          !isHeading(blocks[i + 1]!)
        ) {
          textIdx.push(i + 1);
          consumed.add(i + 1);
        }
        const imageRight = pairCount % 2 === 0; // alternate sides
        pairCount++;
        const textCol = <div className="min-w-0">{mdFor(textIdx)}</div>;
        const imageCol = (
          <figure className="min-w-0">
            <div className="overflow-hidden rounded-xl border border-border bg-muted">{layoutImg(li)}</div>
            {li.caption ? (
              <figcaption className="mt-2 text-xs italic leading-snug text-muted-foreground">{li.caption}</figcaption>
            ) : null}
          </figure>
        );
        bodyNodes.push(
          <div key={`row-${i}`} className="my-2 grid items-center gap-6 md:grid-cols-2">
            {imageRight ? (
              <>
                {textCol}
                {imageCol}
              </>
            ) : (
              <>
                {imageCol}
                {textCol}
              </>
            )}
          </div>,
        );
        continue;
      }

      // Normal block
      bodyNodes.push(<div key={`b-${i}`}>{mdFor(i)}</div>);
      // Full-bleed image after this block?
      if (fullAfter.has(i)) {
        const li = fullAfter.get(i)!;
        bodyNodes.push(
          <figure key={`full-${i}`} className="my-6">
            <div className="overflow-hidden rounded-xl border border-border bg-muted">{layoutImg(li)}</div>
            {li.caption ? (
              <figcaption className="mt-2 text-xs italic leading-snug text-muted-foreground">{li.caption}</figcaption>
            ) : null}
          </figure>,
        );
      }
    }
  }

  // Old-take fallback: distribute inline images evenly between blocks (never after the last).
  const imageAfterIdx = new Set<number>();
  if (!useLayout && inlineImages.length > 0 && blocks.length >= 2) {
    const slots = inlineImages.length;
    const step = Math.max(1, Math.floor(blocks.length / (slots + 1)));
    for (let i = 1; i <= slots; i++) {
      const idx = i * step - 1;
      if (idx >= 0 && idx < blocks.length - 1) imageAfterIdx.add(idx);
    }
  }

  return (
    <div>
      <div className="space-y-5 text-base leading-relaxed">
        {useLayout
          ? bodyNodes
          : blocks.flatMap((block, i) => {
              const nodes: React.ReactNode[] = [
                <ReactMarkdown key={`b-${i}`} remarkPlugins={[remarkGfm]} components={componentsFor(i)}>
                  {escapeMarkers(block)}
                </ReactMarkdown>,
              ];
              if (imageAfterIdx.has(i)) {
                const slotIndex = [...imageAfterIdx].sort((a, b) => a - b).indexOf(i);
                const img = inlineImages[slotIndex];
                if (img) {
                  nodes.push(
                    <figure key={`img-${i}`} className="my-2 overflow-hidden rounded-xl border border-border bg-muted">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={img.url}
                        alt={img.alt ?? img.topic ?? "Editorial illustration"}
                        className="h-auto w-full"
                        loading="lazy"
                        decoding="async"
                      />
                    </figure>,
                  );
                }
              }
              return nodes;
            })}
      </div>

      <CitationSources citations={citations} />
    </div>
  );
}
