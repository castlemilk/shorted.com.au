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
import { TakeBody } from "./take-body";

interface MdxTakeBodyProps {
  body: string;
  citations: TakeCitation[];
}

/**
 * HTML element overrides matching the legacy markdown path's typography
 * (take-body.tsx buildComponents) so both render paths look consistent.
 * Unlike the legacy path these don't linkify bare stock codes — MDX
 * articles use explicit links and <Cite /> markers instead.
 */
const ELEMENT_COMPONENTS = {
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="mb-2 mt-8 text-2xl font-bold tracking-tight text-foreground">{children}</h2>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="mb-2 mt-8 text-xl font-bold tracking-tight text-foreground">{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="mb-1.5 mt-6 text-lg font-semibold tracking-tight text-foreground">{children}</h3>
  ),
  h4: ({ children }: { children?: React.ReactNode }) => (
    <h4 className="mb-1 mt-4 text-base font-semibold text-foreground">{children}</h4>
  ),
  p: ({ children }: { children?: React.ReactNode }) => <p className="text-foreground/90">{children}</p>,
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="ml-5 list-disc space-y-1 text-foreground/90">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="ml-5 list-decimal space-y-1 text-foreground/90">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => <li>{children}</li>,
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
  em: ({ children }: { children?: React.ReactNode }) => <em>{children}</em>,
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-2 border-orange-400/50 pl-4 italic text-foreground/80">{children}</blockquote>
  ),
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">
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
export async function MdxTakeBody({ body, citations }: MdxTakeBodyProps) {
  const processed = preprocessCitationMarkers(body);

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
      <div className={`space-y-5 text-base leading-relaxed ${DROP_CAP_CONTAINER}`}>
        {content}
      </div>
      <CitationSources citations={citations} />
    </div>
  );
}
