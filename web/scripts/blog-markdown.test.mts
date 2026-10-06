import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import matter from "gray-matter";
import { mdxToCleanMarkdown } from "../src/@/lib/blog/clean-markdown.ts";

const blogsDirectory = resolve(import.meta.dirname, "../_blogs");
const post = (slug: string) => matter(readFileSync(resolve(blogsDirectory, `${slug}.mdx`), "utf8")).content;

test("the Zanger article retains every rule, pipeline step and warning", () => {
  const markdown = mdxToCleanMarkdown(post("asx-stock-picker-zanger-breakout-strategy"));
  for (const rule of [
    "1. Explosive growth", "2. A recognisable base", "3. Breakout on volume",
    "4. Cut the loss", "5. Concentrate", "6. Read the market", "7. Let winners run",
  ]) assert.ok(markdown.includes(`| ${rule} |`), rule);
  for (const step of [
    "1. ASIC short positions", "2. Daily prices and volume", "3. XJO for the market regime",
    "4. Typed company fundamentals", "5. **Refresh and evaluate**",
  ]) assert.ok(markdown.includes(step), step);
  assert.ok(markdown.includes("Published four trading days after the date a position is held"));
  assert.ok(markdown.includes("**Unknown never passes**"));
  assert.ok(markdown.includes("A stock with an unknown core rule cannot reach **triggered**"));
  assert.doesNotMatch(markdown, /<(?:GraphTable|Steps|Callout)\b/);
});

test("housing figures retain their labels, exact formatting and hints", () => {
  const prices = mdxToCleanMarkdown(post("australian-house-prices-2026-state-by-state"));
  assert.ok(prices.includes("- $12.77tn dwelling stock — +11.9% over the year"));
  assert.ok(prices.includes("- $1.11M mean dwelling price — +10.3% over the year"));
  assert.ok(prices.includes("- 177.7% household debt to income — roughly flat"));
  assert.ok(prices.includes("- +25.0% Darwin"));
  assert.ok(prices.includes("- +1.8% Melbourne"));

  const cuts = mdxToCleanMarkdown(post("where-asking-prices-are-being-cut-australia-2026"));
  assert.ok(cuts.includes("- 10.5% of listings cut their price"));
  assert.ok(cuts.includes("- 4.3% median cut — average 5.3%"));
  assert.ok(cuts.includes("- $110M asking price removed"));
  assert.ok(cuts.includes("- 29.7% Fawkner"));
  assert.ok(cuts.includes("- 27.0% Frankston South"));
  assert.ok(cuts.includes("- 20.5% Altona Meadows"));
  assert.doesNotMatch(prices + cuts, /<(?:GraphStat|GraphRank)\b|items='/);
});

test("nested wrappers preserve Markdown, image alt text and literal code", () => {
  const source = `import Unused from './unused.js'

<Callout title="A > B">

<ScrollReveal>

Keep **all** of [this link](/picks).

<Quote>Quoted text.</Quote>

</ScrollReveal>

</Callout>

<img src="cover.png" alt="A breakout chart" />

<RegisterEmail />

\`\`\`mdx
<GraphStat items={[{ value: 1 }]} />
\`\`\`
`;
  const markdown = mdxToCleanMarkdown(source);
  assert.ok(markdown.includes("**A > B**"));
  assert.ok(markdown.includes("Keep **all** of [this link](/picks)."));
  assert.ok(markdown.includes("Quoted text."));
  assert.ok(markdown.includes("[A breakout chart]"));
  assert.ok(markdown.includes("```mdx\n<GraphStat items={[{ value: 1 }]} />\n```"));
  assert.doesNotMatch(markdown, /import Unused|<RegisterEmail|<Callout|<ScrollReveal|<Quote/);
});

test("invalid figure JSON and malformed MDX never take extraction offline", () => {
  const invalidData = "Before.\n\n<GraphStat title=\"Data unavailable\" items='invalid' />\n\nAfter.";
  assert.equal(mdxToCleanMarkdown(invalidData), "Before.\n\n**Data unavailable**\n\nAfter.");
  const malformed = "# Heading\n\n<Callout>Useful unfinished content";
  assert.equal(mdxToCleanMarkdown(malformed), malformed);
});

test("all blog articles produce content and preserve ordinary opening prose", () => {
  for (const filename of readdirSync(blogsDirectory).filter((name) => name.endsWith(".mdx"))) {
    const content = matter(readFileSync(resolve(blogsDirectory, filename), "utf8")).content;
    const markdown = mdxToCleanMarkdown(content);
    assert.ok(markdown.length > 100, filename);
    assert.ok(markdown.includes(content.split("\n").find((line) => line.startsWith("# "))!), filename);
    assert.doesNotMatch(markdown, /<RegisterEmail\b/, filename);
  }
});
