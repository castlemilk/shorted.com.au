import { getSource } from "./data/sources";

/**
 * Inline numbered citation. Renders a superscript link to the matching entry in
 * the Sources & method section (`#source-<id>`). Unknown ids render nothing so a
 * typo never throws in the article body.
 */
export function Cite({ id }: { id: string }) {
  const s = getSource(id);
  if (!s) return null;
  return (
    <a
      href={`#source-${s.id}`}
      title={`${s.title} — ${s.publisher} (${s.year})`}
      aria-label={`Source ${s.n}: ${s.publisher}, ${s.year}`}
      className="ml-0.5 align-super text-[0.6em] font-semibold text-primary/80 no-underline transition-colors hover:text-primary"
    >
      [{s.n}]
    </a>
  );
}
