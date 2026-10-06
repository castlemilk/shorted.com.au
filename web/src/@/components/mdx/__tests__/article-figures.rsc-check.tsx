/** Native ESM check: Jest's CommonJS transform cannot load the MDX compiler. */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import React, { type HTMLAttributes, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compileMDX } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import { articleFigureComponents, GraphMeter, GraphRank, GraphSpark, GraphTable, GraphWaterfall } from "../article-figures";
import { parseRankItems, parseStatItems } from "../article-figure-data";

// Real MDX passes component elements before React renders their host tags. This
// reproduces the case where the old parent introspection lost table/step data.
const wrappers = {
  p: (props: HTMLAttributes<HTMLParagraphElement>) => <p {...props} />,
  ul: (props: HTMLAttributes<HTMLUListElement>) => <ul {...props} />,
  ol: (props: HTMLAttributes<HTMLOListElement>) => <ol {...props} />,
  li: (props: HTMLAttributes<HTMLLIElement>) => <li {...props} />,
  table: (props: HTMLAttributes<HTMLTableElement>) => <table {...props} />,
  tr: (props: HTMLAttributes<HTMLTableRowElement>) => <tr {...props} />,
  th: (props: HTMLAttributes<HTMLTableCellElement>) => <th {...props} />,
  td: (props: HTMLAttributes<HTMLTableCellElement>) => <td {...props} />,
};

async function render(source: string) {
  const { content } = await compileMDX({
    source,
    components: { ...wrappers, ...articleFigureComponents },
    options: { mdxOptions: { remarkPlugins: [remarkGfm] } },
  });
  return renderToStaticMarkup(content);
}

async function main() {
  const zanger = readFileSync(resolve("_blogs/asx-stock-picker-zanger-breakout-strategy.mdx"), "utf8");
  const tableSource = zanger.match(/<GraphTable[^>]*>[\s\S]*?<\/GraphTable>/)?.[0];
  const stepsSource = zanger.match(/<Steps[^>]*>[\s\S]*?<\/Steps>/)?.[0];
  const calloutSource = zanger.match(/<Callout[^>]*>[\s\S]*?<\/Callout>/)?.[0];
  assert.ok(tableSource && stepsSource && calloutSource);
  const table = await render(tableSource);
  assert.equal((table.match(/<th(?:\s|>)/g) ?? []).length, 3, "all Zanger column headers render");
  assert.equal((table.match(/<td(?:\s|>)/g) ?? []).length, 21, "all seven rules retain their three cells");
  assert.ok(table.includes('role="region"') && table.includes('tabindex="0"'), "table scroll region supports keyboard focus");
  assert.ok(table.includes("min-w-[36rem]"), "mobile table retains readable column width");
  for (const label of ["1. Explosive growth", "2. A recognisable base", "3. Breakout on volume", "4. Cut the loss", "5. Concentrate", "6. Read the market", "7. Let winners run"]) assert.ok(table.includes(label), label);
  const steps = await render(stepsSource);
  assert.equal((steps.match(/<li(?:\s|>)/g) ?? []).length, 5, "all five daily pipeline steps render");
  for (const phrase of ["Published four trading days", "End-of-day prices and volume", "200-day averages", "fundamentals"]) assert.ok(steps.includes(phrase), phrase);
  const callout = await render(calloutSource);
  assert.ok(callout.includes("Unknown never passes"));
  assert.ok(callout.includes("A stock with an unknown core rule cannot reach"));
  assert.ok(callout.includes("<strong>triggered</strong>"), "rich markdown is preserved");

  const stats = await render(`<GraphStat title="Panel" items='[{"value":"10.5%","label":"of listings cut their price","accent":true},{"value":"4.3%","label":"median cut","hint":"average 5.3%"},{"value":"$110M","label":"asking price removed"}]' />`);
  for (const phrase of ["10.5%", "of listings cut their price", "4.3%", "average 5.3%", "$110M"]) assert.ok(stats.includes(phrase), phrase);
  assert.equal((stats.match(/<dt(?:\s|>)/g) ?? []).length, 3);
  const rank = await render(`<GraphRank title="Prices" max="30" items='[{"label":"Darwin","value":25,"display":"+25.0%"},{"label":"Melbourne","value":1.8,"display":"+1.8%"}]' />`);
  assert.ok(rank.includes("Darwin") && rank.includes("+25.0%") && rank.includes("Melbourne"));
  assert.ok(rank.includes("width:83.333"), "numeric string max applies under safe MDX compilation");
  const stripped = await render(`<GraphRank title="Safe default" items={[{label:"Expression removed",value:25}]} />`);
  assert.ok(!stripped.includes("Expression removed"), "compiler still blocks JavaScript expressions");
  assert.ok(stripped.includes("No data available"));

  const otherFigures = await render(`
<Quote by="Analyst" source="Report">A **careful** quote.</Quote>

<GraphKpi title="Index" value="142" label="Index points" hint="Latest close" data="100 125 142" />

<GraphSlope title="Change" fromLabel="Before" toLabel="After" items='[{"label":"ASX","from":100,"to":125}]' />

<GraphTimeline title="History" events='[{"date":"2026-10-01","label":"Screen updated","state":"now"}]' />

<GraphSpark title="Trend" data="[5,8,3,7]" caption="Four sessions" />

<GraphMeter title="Coverage" value="67%" caption="Fundamentals available" />

<GraphWaterfall title="Cash" items='[{"label":"Opening","value":100},{"label":"Expense","value":-20},{"label":"Closing","value":80}]' />

<GraphCompare title="Strategies" columns='["Growth","Value"]' rows='[{"label":"Momentum","values":[true,false]}]' />

<GraphFlow title="Process" rows='[{"nodes":[{"label":"Screen"},{"label":"Review","tone":"accent"}]}]' />
`);
  for (const phrase of ["Analyst", "careful", "Index points", "Before", "After", "Screen updated", "Four sessions", "67%", "Expense", "-20", "Momentum", "Yes", "No", "Review"]) assert.ok(otherFigures.includes(phrase), phrase);
  assert.equal((otherFigures.match(/data-article-figure/g) ?? []).length, 9);
  assert.ok(!otherFigures.includes("NaN") && !otherFigures.includes("Infinity"));

  // Invalid JSON must produce a useful author error instead of silently losing
  // data or evaluating source; zero/negative/constant data keep finite geometry.
  assert.throws(() => parseRankItems('[{"label":"Bad","value":"n/a"}]'), /invalid data/);
  assert.throws(() => parseStatItems("not JSON"), /valid JSON array/);
  assert.throws(() => parseRankItems('[{"label":"Bad","value":"%"}]'), /invalid data/);
  assert.throws(() => renderToStaticMarkup(<GraphTable rows='[[{"value":"invalid React child"}]]' />), /invalid data/, "JSON object cells fail with a useful author error");
  assert.ok(renderToStaticMarkup(<GraphTable rows={[[<strong key="cell">Rich cell</strong>]]} />).includes("<strong>Rich cell</strong>"), "native React table cells remain supported");
  for (const element of [
    <GraphSpark title="Constant" data={[0, 0, 0]} />,
    <GraphSpark title="One point" data={[-1]} />,
    <GraphSpark title="Empty" data={[]} />,
    <GraphRank title="Zero" items={[{ label: "Zero", value: 0 }]} />,
    <GraphWaterfall title="Zero" items={[{ label: "Opening", value: 0 }, { label: "Closing", value: 0 }]} />,
    <GraphMeter title="Clamped" value="200%" />,
  ]) {
    const html = renderToStaticMarkup(element);
    assert.ok(!html.includes("NaN") && !html.includes("Infinity"));
  }

  const PassThrough = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const blogs = readdirSync(resolve("_blogs")).filter((filename) => filename.endsWith(".mdx"));
  for (const filename of blogs) {
    const source = readFileSync(resolve("_blogs", filename), "utf8");
    const { content } = await compileMDX({
      source,
      components: {
        ...wrappers, ...articleFigureComponents,
        Info: PassThrough, RegisterEmail: () => null, HousingChart: () => null,
        ScrollReveal: PassThrough, CountUp: () => null,
      },
      options: { parseFrontmatter: true, mdxOptions: { remarkPlugins: [remarkGfm] } },
    });
    const html = renderToStaticMarkup(content);
    assert.ok(html.length > 100, `${filename} renders its article body`);
    if (/<Graph(?:Stat|Rank)\b/.test(source)) {
      assert.ok(!html.includes("No data available"), `${filename} retains declarative figure data`);
    }
  }
  process.stdout.write(JSON.stringify({ blogs: blogs.length, checked: "default RSC compilation, all figures, Zanger table and nested steps" }));
}

main().catch((error: unknown) => {
  process.stderr.write(String(error instanceof Error ? error.stack : error));
  process.exitCode = 1;
});
