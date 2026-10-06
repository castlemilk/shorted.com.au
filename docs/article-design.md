# Shorted article design

Shorted articles are the publication side of **The Melbourne Terminal**. The artwork explains a story through a recognisable object and one visual action. The page around it is quiet, with a clear reading column and the same warm theme tokens as the market tools.

This is the implementation guide for blog posts and newsroom Takes. [DESIGN.md](../DESIGN.md) remains the authority for application colours, typography, interaction, and data semantics. [Blog thumbnail directions](blog-thumbnail-directions.md) defines the cover concepts. [Article MDX](article-mdx.md) documents the site-owned figures and safe authoring syntax.

## Palette and materials

Use the existing semantic tokens instead of introducing an article palette in CSS:

| Role | Daylight desk | After hours |
| --- | --- | --- |
| Page | Warm Paper `#F9F8F5` | CRT Black `#0D0D0D` |
| Ink | Chocolate Ink `#483932` | Warm Sand `#E8DEB5` |
| Links and focus | Burnt Amber `#9E5210` | Phosphor Amber `#FFAC4D` |

Illustrations may use sage, rust, mineral blue, ink green or oxblood as material colours and story-specific fields. In UI and data figures, true red and green remain reserved for market direction. Figures use the card and border tokens; no grey shadows, permanent glow, scanlines, or gradient letterboxing surround the artwork.

Artwork can vary in background, subject, and supporting colour. A cream illustration stays cream in dark mode; it is a printed object on the desk, rather than a UI surface to invert. Paper grain, ink, cut edges, and a restrained amber focal point connect the covers without making every topic look alike. Titles and branding stay outside the image pixels.

Give cover artwork one focal moment through a strong silhouette, purposeful contrast and a story-specific action. Close framing, surprising scale and a revealing diagonal can make it captivating within a restrained palette. Keep the surrounding page quiet so the image carries the editorial emphasis. The [art skill](../.claude/skills/shorted-editorial-art/SKILL.md) defines the thumbnail-size impact review.

## Typography

Newsreader signals that the reader has entered a publication. IBM Plex Mono carries the reading text and the evidence, preserving Shorted's identity as an instrument.

| Element | Face and size | Behaviour |
| --- | --- | --- |
| Article title | `pageTitle`, Newsreader, 32/36px then 48px at desktop | One h1, balanced lines, 1.08 line height |
| Standfirst | Newsreader, 20px then 24px | Muted ink, 672px maximum, relaxed leading |
| Body | IBM Plex Mono, 16px then 18px | 1.8 line height, left aligned |
| Major body section | `sectionTitle`, Newsreader, 24px | 48px before, 16px after |
| Subsection | IBM Plex Mono, 20px | 32px before, 12px after |
| Category, byline, date, caption | IBM Plex Mono, 12px | Dates and reading time use tabular numerals |
| Data figures and tables | IBM Plex Mono, 14px | Compact local rhythm; display values can be larger |
| Grid and related card titles | IBM Plex Mono, 18px / 14px | Navigation stays on the mono side of the serif boundary |

Use a concise 25–40-word `standfirst` for the masthead; keep the fuller `excerpt` for listing cards and metadata. At mobile widths, breadcrumbs show the parent category without repeating the long headline above the h1.

The featured story on the blog index is an editorial display hero and uses `sectionTitle`. Quotes within body copy use mono. Existing newsroom drop caps remain confined to the first prose paragraph. Do not introduce serif into dashboard cards, controls, tables, or numbers.

## Composition

The desktop article has an **864px masthead** and a **672px reading column**. The reading column holds approximately 62 characters at the desktop body size. All content is left aligned; the columns are centred on the page.

```text
                   breadcrumb
           category / beat
           headline, one h1
           standfirst
           author     date     reading time
           ────────────────────────────────
           artwork, 16:9, maximum 864px
                reading column, 672px
                prose and section headings
                evidence figure / table
                source and sharing controls
```

On mobile the columns become the available width, without an article sidebar. Meta information wraps into complete items; decorative separators cannot be orphaned on a new line. Tables scroll within a labelled keyboard-focusable region instead of widening the page. Newsroom image placements remain full, left, right, or inset, within the reading column.

The cover is a stable 16:9 image on the article, blog grid, related rail, and featured story. `object-cover` fills the frame; generation briefs keep the subject and visual action within the central safe area. Covers use a hairline border and the system's 6px radius. A cover does not zoom on hover. Card hover changes its border and link colour; keyboard focus uses the theme's visible ring.

Blog cards use a separate 800 × 450 `thumbnailImage` export of the approved artwork; article mastheads, featured stories and OpenGraph retain the 1600 × 900 `coverImage`. The exporter at `web/scripts/editorial-thumbnails.mts` keeps the crop and versions aligned. The [editorial art skill](../.claude/skills/shorted-editorial-art/SKILL.md) defines composition and material checks for new covers.

## Prose and evidence

`.article-prose` owns the reading rhythm across blog MDX, newsroom MDX, citation-aware markdown, and legacy markdown. The shared `articleHtmlComponents` map owns blog and newsroom MDX heading, list, link, and table markup. A body's h1 is demoted to h2 so the masthead remains the single page h1.

Use a plain paragraph until a real comparison, sequence, warning, or number benefits from a figure. Figures are evidence, rather than decorative cards between every section. The site-owned renderers use a flat card surface, 6px corners, mono titles, and a 1px warm border. Warnings use warm rust, notes use amber; prose remains normal foreground ink.

Figure and callout descendants are explicitly excluded from body margin selectors. This keeps a small chart caption small, a numbered sequence intact, and a table's rows compact. Code blocks use theme surfaces and horizontal scrolling. Prose links are underlined and have a visible keyboard outline.

Captions describe the object or evidence. Credits remain readable mixed-case text. Source dates, ASIC disclosure lag, units, and methodology travel with figures when relevant. Illustration is never presented as measured data, an actual forecast, or a verified provider interface.

## Design review

The first pass retained the established warm paper and terminal palette, separated the broad masthead from the reading column, and made the artwork the memorable feature. The second pass removed the old dark image panels, permanent radial glow, decorative image zoom, repeated meta separators, and an extra featured-story CTA. It also restored the mono card-title boundary and replaced oversized rounded corners and coloured callout stripes with the system's hairlines.

Review at 390px and a desktop viewport in both themes. Check one representative long headline, the smallest cover crop, a long table, a rich MDX sequence, keyboard focus, and source captions. The article should read comfortably when the art is removed; the art should still communicate its subject at thumbnail size.

## Future newsroom artwork

The Take writer's art director defaults hero plans to `paper_collage` or `still_life`, with `printmaking` available for supporting illustrations. Each brief identifies a concrete subject and one meaningful visual action. Palette and ground follow the subject; light paper and dark ink are both valid. Captions begin `Illustration:` and describe the conceptual action without claiming to document a real place, event, facility or historical record.

Legacy style keys remain accepted for stored plans. Photographic and archival treatments now describe arranged material studies or visibly reconstructed models, rather than fabricated wire photographs. The legacy newsroom brand and inline prompts follow the same direction. Its cohesion validator accepts a specific conceptual metaphor and requests a paper-collage correction when a hero needs regeneration, instead of replacing valid illustrations with simulated photojournalism.

These presets are maintained in `scripts/take-writer/src/art-director.ts`, `newsroom.ts`, and `validator.ts`. Changing a preset does not regenerate, publish or deploy an existing article. Generation calls, upload paths and article data APIs remain part of the existing pipeline.
