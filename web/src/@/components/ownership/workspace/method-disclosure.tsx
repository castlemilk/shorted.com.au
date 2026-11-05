/**
 * The method behind a workspace page, folded to one line (backlog B1). The page's own
 * paragraphs (a fund's self-comparison, a notice's change) come first as `extra`, each
 * already a paragraph; the three shared paragraphs follow, each with its first sentence
 * as a lead. The details is closed by default, and the full text is in the HTML: a closed
 * details keeps its content in the DOM, so crawlers and the methodology read every word.
 *
 * A plain module, server-safe: no "use client", no Connect, no generated code. Pages draw
 * it into ISR HTML.
 */

import type { ReactNode } from "react";
import { cn } from "~/@/lib/utils";
import { METHOD_PARAGRAPHS } from "../ownership-parts";

/**
 * Words that end in a full stop without ending a sentence: a company's form ("Pty. Ltd."),
 * an abbreviation the copy uses. The lead does not break after them.
 */
const NOT_A_SENTENCE_END = new Set([
  "Pty",
  "Ltd",
  "Inc",
  "Corp",
  "Co",
  "No",
  "Nos",
  "Dr",
  "Mr",
  "Ms",
  "Mrs",
  "St",
  "vs",
  "e.g",
  "i.e",
  "approx",
  "Cth",
  "cf",
]);

/**
 * A paragraph's first sentence and the rest. The sentence ends at the first full stop, with an
 * optional closing quote or bracket, followed by a space and an uppercase letter or a digit, so a
 * figure ("605. 2 more") and a sentence ending in a number both break correctly, a sentence ending
 * in a quotation or a parenthesis breaks too, and a known abbreviation does not. Joined with a
 * space, the two halves are the original text. A paragraph with no such break is all lead, with an
 * empty rest.
 */
export function leadSentence(text: string): { lead: string; rest: string } {
  const breaks = /\.["')\]]? (?=[A-Z0-9])/g;
  for (let match = breaks.exec(text); match !== null; match = breaks.exec(text)) {
    const word = (text.slice(0, match.index).match(/(\S+)$/)?.[1] ?? "").replace(/^[(["'[]+/, "");
    if (NOT_A_SENTENCE_END.has(word)) continue;
    const end = match.index + match[0].length;
    return { lead: text.slice(0, end - 1), rest: text.slice(end) };
  }
  return { lead: text, rest: "" };
}

/** One shared paragraph: its lead sentence in the foreground, the rest in the muted colour. */
function MethodParagraph({ text }: { text: string }) {
  const { lead, rest } = leadSentence(text);
  return (
    <p>
      <span className="text-foreground">{lead}</span>
      {rest === "" ? null : (
        <>
          {" "}
          <span className="text-muted-foreground">{rest}</span>
        </>
      )}
    </p>
  );
}

export function MethodDisclosure({ extra = [], className }: { extra?: ReactNode[]; className?: string }) {
  return (
    <details id="method" className={cn("scroll-mt-20", className)}>
      <summary className="cursor-pointer text-xs text-primary underline-offset-4 hover:underline">
        How these figures are read
      </summary>
      <div className="max-w-[80ch] space-y-2 pt-2 text-xs text-muted-foreground">
        {extra}
        {METHOD_PARAGRAPHS.map((text) => (
          <MethodParagraph key={text.slice(0, 40)} text={text} />
        ))}
      </div>
    </details>
  );
}
