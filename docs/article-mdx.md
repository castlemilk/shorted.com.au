# Authoring blog diagrams and figures

Blog content lives in `web/_blogs/*.mdx`. The component whitelist is
`web/src/@/components/blog/mdx-components.tsx`, and the project's editorial
figure implementations live in
`web/src/@/components/mdx/article-figures.tsx`. Extend those local components
when a story needs a diagram. Do not import or vendor mdxcn registry figures.

Figures render meaningful HTML on the server. Tables, ordered lists, labels
and displayed values remain readable without chart hydration or animation.
Use native Markdown when it already communicates the information clearly.

## Data attributes

The MDX compiler keeps `blockJS: true`, the `next-mdx-remote` v6 default.
JavaScript expression props such as `items={[...]}`, `max={30}` and
`accent={true}` are removed. Use quoted literal attributes and valid JSON
strings for structured data. The components parse and validate JSON; they do
not evaluate code.

```mdx
<GraphStat
  title="30 days to 24 September 2026"
  items='[
    {"value":"10.5%","label":"of listings cut their price","accent":true},
    {"value":"4.3%","label":"median cut","hint":"average 5.3%"}
  ]'
/>

<GraphRank
  title="Share of listings discounted"
  max="30"
  items='[
    {"label":"Fawkner","value":29.7,"display":"29.7%"},
    {"label":"Frankston South","value":27,"display":"27.0%"}
  ]'
/>
```

`GraphStat` items have `value` (string or number), `label`, optional `hint`,
and optional `accent` (boolean). `GraphRank` items have `label`, numeric
`value`, optional formatted `display`, and optional `accent`. `max` is an
optional scale ceiling. Preserve the units and precision in `display`;
numeric values control the bar widths. Cite the source and observation date
in the surrounding prose, and use the same numbers in any accompanying table.

These examples use single quotes around the JSON attribute and double quotes
inside JSON. Encode an apostrophe in JSON text as `\u0027` if it would close
the enclosing MDX attribute. Do not put child markers such as `<Stat>` or
`<Rank>` inside a figure.

## Tables, sequences and prose

Keep blank lines between a component tag and its Markdown children.
`GraphTable` retains the table; `Steps` retains the ordered list and its rich
paragraphs. No component tries to discover data by inspecting React children.

```mdx
<GraphTable title="Rules and their data sources">

| Rule | Test | Data |
| --- | --- | --- |
| Breakout | Close above the prior high | Daily prices |
| Volume | Above the trailing average | Daily volume |

</GraphTable>

<Steps title="The daily pipeline">

1. Collect prices and volume

   Use the published end-of-day observations.

2. Refresh and evaluate

   Recompute the strategy rules after the price sweep completes.

</Steps>

<Callout type="warning" title="Unknown never passes">

A missing observation reads **unknown** and cannot count as a pass.

</Callout>

<Quote>

A short quotation with its attribution and source in the surrounding prose.

</Quote>
```

The existing live `HousingChart` remains available for actual series data:

```mdx
<HousingChart regionCode="AUS" measure="mean_price" ariaLabel="National mean dwelling price" format="aud" />
```

## Validation

Compile using the production MDX options, including default JavaScript
blocking, and check the rendered HTML for every label, value, table row and
step. View the article at its real `/blog/<slug>` route at desktop and mobile
widths. Confirm that the cover and OpenGraph paths exist under `web/public/`.
New components need a meaningful rendering test and must be registered in
`BLOG_MDX_FIGURES` and `blogMdxComponents`.

The plain-text `/blog/<slug>/llm` route uses the same figure data validators to
preserve stats and ranks, and unwraps tables, steps and caveats into readable
Markdown. Include any new data component in that extraction path too. Check
the actual articles with `cd web && node --import tsx --test scripts/blog-markdown.test.mts`.

The newsroom's stored news articles use a separate project-owned palette in
`web/src/@/components/news/mdx/`. Its registry, Zod manifest and take-writer
prompt must stay in sync; see `.claude/skills/newsroom/SKILL.md`.
