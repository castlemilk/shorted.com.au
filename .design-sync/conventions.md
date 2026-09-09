## Shorted: "The Melbourne Terminal"

Institutional-grade market instrumentation that grew up somewhere warm. Trading-terminal
density and numeric discipline, without the coldness: no navy, no steel, no glass. Every
neutral is tinted toward amber, and the two themes read as two rooms rather than two
palettes: light is a daylight desk (warm paper), dark is the same desk after hours, lit by
phosphor. If a screen could belong to any generic fintech SaaS product, it has failed.

### Setup

Components need **no provider**. Tokens are plain CSS custom properties in the stylesheet's
`:root`, so anything you render is styled already. Two exceptions:

- **Dark mode** is class-based: put `class="dark"` on an ancestor (there is no ThemeProvider
  in this bundle). Always check both rooms.
- **`Tooltip`** must be wrapped in `TooltipProvider` (exported here). `Toaster` is a
  singleton, mount once at the root.

**`asChild` triggers need a ref-forwarding child.** `Button` forwards a ref and is safe.
`Badge` is a plain function component, so `<TooltipTrigger asChild><Badge/></TooltipTrigger>`
renders the trigger and then *silently no tooltip at all*: Radix loses the ref, the popper
anchor is never measured, and the portal never positions. Wrap it:
`<TooltipTrigger asChild><span tabIndex={0} className="inline-flex"><Badge/></span></TooltipTrigger>`.
Same trap for `PopoverTrigger` / `DropdownMenuTrigger` over any non-forwardRef export.

Compound parts are all on the global even though only the primary component has a card:
`Card` ships `CardHeader` / `CardTitle` / `CardDescription` / `CardContent` / `CardFooter`,
`Dialog` ships `DialogTrigger` / `DialogContent` / `DialogHeader` / `DialogTitle`, and so on.
Import them by name.

### The styling idiom: Tailwind utilities over semantic tokens

Style with utility classes bound to the token layer, **never raw hex**. The vocabulary:

| Family | Classes |
|---|---|
| Surface | `bg-background`, `bg-card`, `bg-muted`, `bg-popover` |
| Ink | `text-foreground`, `text-muted-foreground`, `text-card-foreground` |
| Brand | `bg-primary` / `text-primary` (Burnt Amber by day, Phosphor Amber at night) |
| Support | `bg-secondary` (avocado), `bg-accent` (clay rust), `bg-destructive` |
| Edges | `border` + `border-input` (control boundary, deliberately heavier than the hairline) |
| Focus | `focus-visible:ring-2 ring-ring ring-offset-2` |
| Glow | `shadow-amber-sm`, `shadow-amber`, `shadow-amber-lg`, `shadow-amber-glow` |
| Texture | `.text-glow`, `.box-glow`, `.scanlines` |

Radii are `rounded-md` (4px, controls) and `rounded-lg` (6px, cards). Borders are 1px.

### The rules that make it look like Shorted

1. **Monospace-first.** IBM Plex Mono is the *application* face, not a code accent: chrome,
   labels, tables, buttons, navigation and every numeral. It is already the default; do not
   override it.
2. **The serif boundary.** Newsreader (`font-serif`) is permitted only on page titles,
   standalone section headlines, and editorial heroes. Forbidden on card titles, widget
   labels, control bars, table headers, buttons, navigation, and all numerals. Chrome is mono.
   The type stacks (import-free, use verbatim):
   - page title: `font-serif text-3xl font-bold tracking-tight text-balance sm:text-4xl`
   - section title: `font-serif text-2xl font-semibold tracking-tight text-balance`
   - eyebrow: `font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground`
   - lede: `mt-2 max-w-2xl text-muted-foreground`
3. **Numbers are first-class.** Every numeral `tabular-nums`, right-aligned in tables,
   compact AUD (`$1.2B`, `$340M`, `11.62%`). Columns align on the decimal.
4. **Flat at rest.** Depth is tonal (cards lift toward white by day, two points off black at
   night) plus a warm hairline border. There is **no grey drop-shadow vocabulary**. Amber
   glow is a response to state (hover, focus, active, a data condition), never a texture, and
   at most one `shadow-amber-lg` / `.box-glow` per view.
5. **Semantic quarantine.** True red and green mean *direction of a number* and nothing else.
   Never for brand accent, decoration, or generic success/error. Everything else warms to
   rust or olive. Chart series use the warm palette (rust, avocado, amber stroke).
6. **Provenance is composition.** Data ships with its source: ASIC attribution, T+4 lag,
   as-at date, methodology link. "Not financial advice" is load-bearing.

Never: purple-blue gradients, gradient text, glassmorphism, identical icon-card grids,
accent stripes heavier than 1px, a glow left on at rest, Phosphor Amber as text on a light
background (it fails AA), or em dashes in UI copy.

### Where the truth lives

`_ds/<folder>/styles.css` and its `@import` closure is the real token and utility source.
`guidelines/DESIGN.md` is the full design system with contrast measurements and rationale.
Each component's `<Name>.prompt.md` and `<Name>.d.ts` carry its API.

### Idiomatic composition

```tsx
<Card className="max-w-sm">
  <CardHeader className="pb-3">
    <p className="font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">
      Short interest
    </p>
    <CardTitle>Pilbara Minerals</CardTitle>
    <CardDescription>PLS, Materials, as at 12 Sep</CardDescription>
  </CardHeader>
  <CardContent className="flex items-baseline justify-between">
    <span className="text-2xl font-semibold tabular-nums">19.4%</span>
    <Badge variant="secondary">ASX 200</Badge>
  </CardContent>
  <CardFooter>
    <Button size="sm">Open</Button>
  </CardFooter>
</Card>
```
