// Compile gate for LLM-emitted MDX. The component whitelist + prop schemas
// are the security boundary on the pipeline side: no imports/exports, no
// unknown JSX, props validated, charts verified against real stock codes,
// cites against the ledger. Mirrors web/src/@/components/news/mdx/manifest.ts
// — keep the two in sync when the palette changes.
import { compile } from "@mdx-js/mdx";
import { z } from "zod";

const WINDOWS = ["1m", "3m", "6m", "1y"] as const;

export const COMPONENT_SCHEMAS: Record<string, z.ZodTypeAny> = {
  ShortInterestChart: z.object({
    code: z.string().regex(/^[A-Z0-9]{2,5}$/),
    window: z.enum(WINDOWS).optional(),
  }),
  PriceChart: z.object({
    code: z.string().regex(/^[A-Z0-9]{2,5}$/),
    window: z.enum(WINDOWS).optional(),
  }),
  StatGroup: z.object({}),
  Stat: z.object({
    label: z.string().min(1),
    value: z.string().min(1),
    context: z.string().optional(),
    cite: z
      .string()
      .regex(/^ref-\d+$/)
      .optional(),
  }),
  PullQuote: z.object({}),
  Figure: z.object({
    src: z.string().url(),
    caption: z.string().optional(),
    credit: z.string().optional(),
    placement: z
      .enum(["full", "left", "right", "inset"])
      .optional(),
  }),
  Timeline: z.object({}),
  TimelineEvent: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    label: z.string().min(1),
    cite: z
      .string()
      .regex(/^ref-\d+$/)
      .optional(),
  }),
};

export interface MdxGateOptions {
  ledgerRefs: Set<string>;
  knownCodes: Set<string>;
}

export interface MdxGateResult {
  ok: boolean;
  errors: string[];
  componentCount: number;
}

const ATTR = /([a-zA-Z]+)\s*=\s*"([^"]*)"/g;

/** Extract {name, props} for every capitalised JSX element via regex —
 *  intentionally simple; compile() below is the real syntax check.
 *  Only matches opening/self-closing tags (not </Tag> closing tags). */
export function extractComponents(
  body: string,
): Array<{ name: string; props: Record<string, string> }> {
  const out: Array<{ name: string; props: Record<string, string> }> = [];
  // Matches <ComponentName ...> and <ComponentName .../> but NOT </ComponentName>
  for (const m of body.matchAll(/<([A-Z][A-Za-z]*)\b([^>]*?)\/?>/g)) {
    const props: Record<string, string> = {};
    for (const a of m[2]!.matchAll(ATTR)) props[a[1]!] = a[2]!;
    out.push({ name: m[1]!, props });
  }
  return out;
}

export async function validateMdx(
  body: string,
  opts: MdxGateOptions,
): Promise<MdxGateResult> {
  const errors: string[] = [];

  // Security checks: no imports/exports or script tags
  if (/^\s*(import|export)\s/m.test(body))
    errors.push("import/export statements are forbidden");
  if (/<script\b/i.test(body)) errors.push("script tags are forbidden");

  // Fail-closed backstop: a literal \n / \t / \r escape sequence glued to a
  // JSX component means escape-normalisation (narrative.normaliseEscapeSequences)
  // was bypassed — the component won't render on its own line and "\n" prints on
  // the page. Reject so the body degrades to markdown rather than shipping broken.
  if (/\\[nrt]\s*<[A-Z]/.test(body) || /\/>\s*\\[nrt]/.test(body))
    errors.push("literal escape sequence (\\n/\\t) adjacent to a component — body not normalised");

  const comps = extractComponents(body);

  for (const c of comps) {
    const schema = COMPONENT_SCHEMAS[c.name];
    if (!schema) {
      errors.push(`unknown component <${c.name}>`);
      continue;
    }

    const parsed = schema.safeParse(c.props);
    if (!parsed.success) {
      errors.push(
        `<${c.name}> invalid props: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
      continue;
    }

    // Verify chart stock codes against the known-codes set
    if (
      (c.name === "ShortInterestChart" || c.name === "PriceChart") &&
      !opts.knownCodes.has(c.props.code ?? "")
    ) {
      errors.push(
        `<${c.name}> unknown stock code "${c.props.code}"`,
      );
    }

    // Verify cites against the ledger
    if (c.props.cite && !opts.ledgerRefs.has(c.props.cite)) {
      errors.push(
        `<${c.name}> cites ${c.props.cite} which is not in the ledger`,
      );
    }
  }

  // Only attempt MDX compile if no errors so far (fail-fast)
  if (errors.length === 0) {
    try {
      await compile(body, { format: "mdx" });
    } catch (err) {
      errors.push(
        `mdx compile failed: ${String((err as Error).message).slice(0, 200)}`,
      );
    }
  }

  return { ok: errors.length === 0, errors, componentCount: comps.length };
}

/** Degrade MDX to plain markdown: PullQuote → blockquote, Stat → bold line,
 *  TimelineEvent → list item, everything else removed. */
export function stripMdxComponents(body: string): string {
  return body
    .replace(
      /<PullQuote>([\s\S]*?)<\/PullQuote>/g,
      (_m, t: string) => `> ${t.trim()}`,
    )
    .replace(
      /<Stat\b(?=[^>]*\blabel="([^"]*)")(?=[^>]*\bvalue="([^"]*)")[^>]*\/>/g,
      "**$1: $2**",
    )
    .replace(
      /<TimelineEvent\b(?=[^>]*\bdate="([^"]*)")(?=[^>]*\blabel="([^"]*)")[^>]*\/>/g,
      "- $1 — $2",
    )
    .replace(/<\/?[A-Z][A-Za-z]*\b[^>]*>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
