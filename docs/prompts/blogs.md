Write a Shorted blog post about the requested topic in Australian English.
Explain the subject clearly, support factual claims with sources and dated
observations, and use concrete examples. Keep financial descriptions factual;
do not imply that a screen result or a trading strategy guarantees a return.

Save the article as `web/_blogs/<slug>.mdx` with the established frontmatter:
`title`, `excerpt`, `standfirst`, `coverImage`, `thumbnailImage`, `coverAlt`, `date`, `category`, `tags`, `author` and
`ogImage.url`. Use an existing category and point the cover and OpenGraph image
at a real asset in `web/public/assets/blog/<slug>/`.

Write a concise 25–40-word standfirst for the masthead. Keep the fuller excerpt
for listing cards and SEO.

Use ordinary Markdown for prose, headings, links, lists and tables. Add a visual
only when it clarifies the point. The blog's project-owned MDX components are
documented in [article-mdx.md](../article-mdx.md):

- `GraphStat` for a small set of sourced headline figures.
- `GraphRank` for a numeric comparison with explicit labels and values.
- `GraphTable` for a titled Markdown table.
- `Steps` for a real sequence in a Markdown ordered list.
- `Callout` for a caveat and `Quote` for a short quotation.
- `HousingChart` for the site's live housing series.

Use literal string attributes. Put figure data in a valid JSON string, such as
`items='[{"value":"10.5%","label":"of listings cut their price"}]'`.
Do not write JavaScript expression props (`items={[...]}`), import components
inside a post, or use child markers such as `Stat` or `Rank`. Keep the MDX
compiler's default JavaScript blocking enabled. Build additional diagrams in
the local component palette when needed; do not fetch or vendor mdxcn.

Use [article-design.md](../article-design.md) for layout, type and evidence styling.

For a new cover image, use the [thumbnail art direction](../blog-thumbnail-directions.md).
Follow the [editorial art skill](../../.claude/skills/shorted-editorial-art/SKILL.md) for craft review and the matching 800 × 450 thumbnail export.
Write a concise image-generation prompt around the article's specific finding
or mechanism: one concrete subject and one readable visual action. Compose
an image-led 16:9 editorial thumbnail with no title or numbers baked into it.
Keep Shorted's warm ink, paper and selective amber, while allowing the subject
its own restrained palette. Do not repeat a generic chart, Australia silhouette
or housing scene across unrelated articles. Generate the asset, keep the prompt
and export a versioned 1600 × 900 WebP in the article's asset directory.
Set the same artwork as `ogImage.url` and describe its subject/action in `coverAlt`. Do not leave `<insert>`
placeholders in a published post.
Check the compiled article at its `/blog/<slug>` route and at mobile width,
including every figure's content and the cover image, before considering it
ready.
