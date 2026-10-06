import React from "react";
import { compileMDX } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import {
  CitationPill,
  CitationSources,
  preprocessCitationMarkers,
  resolveCitation,
  type TakeCitation,
} from "./citations";
import { DROP_CAP_CONTAINER } from "./drop-cap";
import { injectLayoutFigures, type LayoutImageLike } from "./mdx-figures";
import { TakeBody } from "./take-body";
import { articleHtmlComponents } from "~/@/components/mdx/article-html";

interface MdxTakeBodyProps {
  body: string;
  citations: TakeCitation[];
  /** Art-directed layout images woven in as <Figure /> blocks (no-op if the writer already placed figures). */
  layoutImages?: LayoutImageLike[];
}

/**
 * HTML element overrides matching the legacy markdown path's typography
 * (take-body.tsx buildComponents) so both render paths look consistent.
 * Unlike the legacy path these don't linkify bare stock codes — MDX
 * articles use explicit links and <Cite /> markers instead.
 */
const ELEMENT_COMPONENTS = {
  ...articleHtmlComponents,
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
  em: ({ children }: { children?: React.ReactNode }) => <em>{children}</em>,
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary">
      {children}
    </a>
  ),
  code: ({ children }: { children?: React.ReactNode }) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">{children}</code>
  ),
  hr: () => <hr className="my-6 border-border" />,
};

/**
 * Server component rendering an MDX-format editorial Take body via
 * next-mdx-remote/rsc, with the same citation pills + Sources list as
 * the legacy markdown path.
 *
 * [ref-N]/[report-N] markers are string-replaced to <Cite refId="…" />
 * before compilation (skipping code fences — see citations.tsx).
 *
 * Error safety: the MDX component palette (and the dynamic-import chart
 * components inside it) is loaded lazily and compilation happens inside
 * try/catch — any failure falls back to the legacy markdown renderer,
 * which handles the body minus custom components gracefully.
 */
export async function MdxTakeBody({ body, citations, layoutImages }: MdxTakeBodyProps) {
  // Weave art-directed layout images into the source as <Figure /> blocks
  // (skipped entirely when the writer placed its own figures), then resolve
  // citation markers — order doesn't matter, but both must precede compile.
  const withFigures = injectLayoutFigures(body, layoutImages ?? []);
  const processed = preprocessCitationMarkers(withFigures);

  // Cite receives the citations array via closure; resolveCitation maps
  // the refId to its citation (pill shows the N in ref-N, amber for reports).
  const Cite = ({ refId }: { refId?: string }) => (
    <CitationPill
      refId={refId ?? ""}
      citation={refId ? resolveCitation(refId, citations)?.citation : undefined}
    />
  );

  let content: React.ReactElement;
  try {
    // Lazy import so a registry-level failure (e.g. next/dynamic ssr:false
    // restrictions in server components) is caught and falls back too.
    const { MDX_COMPONENTS } = await import("./mdx/registry");
    const compiled = await compileMDX({
      source: processed,
      components: { ...ELEMENT_COMPONENTS, ...MDX_COMPONENTS, Cite },
      options: { mdxOptions: { remarkPlugins: [remarkGfm] } },
    });
    content = compiled.content;
  } catch (err) {
    console.error("[mdx-take-body] MDX compile failed, falling back to markdown renderer:", err);
    return <TakeBody bodyMd={body} citations={citations} />;
  }

  return (
    <div>
      {/* Compiled MDX paragraphs are direct children, so the container
          drop-cap variant (`> p:first-of-type`) hits exactly the first
          paragraph even when the body opens with a heading. */}
      <div className={`article-prose ${DROP_CAP_CONTAINER}`}>
        {content}
      </div>
      <CitationSources citations={citations} />
    </div>
  );
}
