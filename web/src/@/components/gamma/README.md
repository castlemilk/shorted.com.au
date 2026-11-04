# Gamma components in the site

The owner's Gamma library (`~/projects/gamma`) vendored for the ownership
workspace (spec 14.5). Only the components the workspace calls for are here, and
each is copied verbatim from its source file; nothing of the explorer is.

## What is here

| Component | Source (`~/projects/gamma/src/components/`) | CSS block in `gamma.css` |
|---|---|---|
| `SegmentedControl` | `SegmentedControl.tsx` | Segmented control |
| `FilterBar` | `FilterBar.tsx` | Filter bar |
| `SearchCombobox` | `SearchCombobox.tsx` | Search combobox |
| `BreadcrumbTrail` | `BreadcrumbTrail.tsx` | Breadcrumb trail |
| `DisclosureStack` | `DisclosureStack.tsx` | Disclosure stack |
| `SideSheet` | `SideSheet.tsx` | Side sheet |
| `KpiCard` | `KpiCard.tsx` | KPI card |
| `RangeSlider` | `RangeSlider.tsx` | Range slider |
| `Tooltip` | `Tooltip.tsx` | Tooltip |
| `EmptyState` | `EmptyState.tsx` | Empty state |
| `Skeleton` | `Skeleton.tsx` | Loading and micro motion primitives (the `gamma-skeleton*` rules) |
| `AvatarGroup` | `AvatarGroup.tsx` | Avatar group |
| `DataTable` | `DataTable.tsx` (local copy, see "Local changes") | Data table, in `DataTable.css` |

`DataTable` (spec 14.5, 14.7) is vendored with its `motion/react` imports removed,
so the web app gains no dependency (`package.json` is unchanged) and its row and
panel motion is CSS transitions or none (see "Local changes"). The Funds page
draws its fund exposure map from it.

The TSX is unchanged except for the local changes below (the `SideSheet` type,
and `DataTable`'s motion removal and class names) and the vendoring fixes that the
site's lint rules require (see below). Their imports (`react`, `lucide-react`, `clsx`,
`tailwind-merge`) all resolve in `web`.

## The CSS

`gamma.css` holds the CSS block of each component, from its `/* Name */` comment
in `library.css` up to the next top-level comment, one header per block. The
Data table block is the exception: it lives in `DataTable.css` (spec 14.7), which
only a page that draws `DataTable` imports, so the other workspace pages do not
load its rules. The
library's `*-demo` rules, and the `gamma-progress`, `gamma-reveal` and `gamma-tilt`
rules that no kept component draws, are removed. The rules of the kept components
are unchanged, selector by selector. The
classes are the library's own (unprefixed for most components, `gamma-skeleton*`
for the skeleton). Two class hooks the TSX sets, `avatar-group-collapse` and
`segmented-control-label`, have no rule in the library and so none here.

`gamma-bridge.css` defines every `--gamma-*` custom property those blocks read,
in both `:root` (light) and `.dark`, from the site's own tokens in
`src/styles/globals.css`:

- surfaces and ink from `--background`, `--card`, `--muted`, `--foreground`,
  `--muted-foreground`, `--border`; the accent is `--primary`;
- status: red and green are the direction of a market number, so the bridge
  never maps a status tone to them. Gamma's success (a rise, an online presence)
  reads the amber accent and danger (a fall, a busy presence) reads ink, the
  pairing spec 14.3 uses for fund changes; warning is Gamma's amber. The test
  `gamma-bridge.test.ts` fails if a tone resolves to the green or the destructive
  red in either theme;
- type: the site's mono (`--font-sans`) for UI and code, its serif
  (`--font-serif`) for display;
- radii from `--radius`; durations and eases are Gamma's.

`__tests__/gamma-bridge.test.ts` greps `gamma.css` and `DataTable.css` for every `var(--gamma-...)`
and fails if either theme misses one, and it fails on the em dash in any file here.

## Loading

`app/ownership/layout.tsx` imports `gamma-bridge.css` and `gamma.css` once, for
the workspace pages. An App Router layout keeps its CSS loaded after the visitor
navigates away from `/ownership`, so the rules must stay scoped to the library's
classes: a rule that targets a bare element would apply on other routes too, and
is a review point whenever a block is copied.

## Changing a component

Change the library, then copy the file and its block again. The copy is the
record: do not edit these files by hand except to satisfy lint or the local
changes below, and record each such edit there.

## Local changes

These are changes to the vendored copy, not to Gamma. Gamma itself is not
edited (spec 14.7).

- `SideSheet` takes `side="bottom"` (the type in `SideSheet.tsx` widened, its
  behaviour otherwise unchanged). The sheet below `lg` opens from the bottom
  edge: `gamma.css` carries a `.side-sheet[data-side="bottom"]` block and its
  `side-sheet-enter-bottom` keyframe, under the "Side sheet" block. Reduced
  motion turns it off with the rest of the sheet.
- `DataTable` (`DataTable.tsx`) has no `motion/react` import. Its `motion.*`
  elements are plain elements; the `AnimatePresence` and `LayoutGroup` wrappers are
  fragments; the spring presets, `useSpring`, the layout animation of reordered
  rows and the exit wave's `onAnimationComplete` are gone. A row leaving a bulk
  delete fades out with a CSS transition whose delay is its place in the wave
  (`LEAVE_MS`, `WAVE_STEP_MS`), and `onRowLeft` runs on a timer after the same
  schedule. The `animate` prop is removed. Its Gamma utility classes
  (`text-gamma-muted`, `bg-gamma-ink`, `rounded-gamma-control`, ...) are the site's
  own tokens (`text-muted-foreground`, `bg-foreground`, `rounded-md`, ...), since the
  site's Tailwind config does not define the `gamma-` colours. Its CSS block is
  copied from `library.css` ("Data table") in full, with no `*-demo` rules, into
  `DataTable.css` rather than `gamma.css`. Under `prefers-reduced-motion` the row
  wave has no fade and no delay (the row carries `motion-reduce:transition-none`,
  and the rows leave on a zero timer).
- `KpiCard`'s value takes the UI face, not the display serif (`.kpi-card-value`
  in `gamma.css`). DESIGN.md sets numerals in mono, and the serif stays for page
  titles and the inspector's name. The bridge is unchanged.
- `SegmentedControl` takes an optional `title` on each option, passed to the
  option's `<label>` (spec 14.8: a disabled Source option says why it is disabled).
- The `gamma.css` blocks of the components above are no longer copied byte for
  byte, for these two rules only; the comments in `gamma.css` mark each change.

## Vendoring fixes applied

- `gamma.css`: the `*-demo`, `gamma-progress`, `gamma-reveal` and `gamma-tilt`
  rules removed, selector by selector (see "The CSS" above).
- `--gamma-danger` maps to the foreground ink, so `SearchCombobox`'s error text
  reads as body copy and not as red. That is accepted on purpose: red and green
  are the direction of a market number, and an error is not one.

- `SearchCombobox.tsx`: `query ?? internalQuery` for the same value (undefined
  only); a list index read guarded with `?.`; the falsy `||` reads are kept as
  they are, each with a disable comment saying why (a `false` aria value is not
  the same as none); the listbox option's click and the field's keyboard are one
  control, so the option's click carries a disable comment.
- `SideSheet.tsx`: the native dialog's backdrop click, which Escape already
  closes, carries a disable comment.
- `DataTable.tsx`: the `||` and `?:` reads that the site's lint rules flag are kept
  as they are, each with a disable comment saying why (an empty label falls through;
  a `maxHeight` of 0 is no cap); the grid's keyboard model and the focusable splitter
  carry their disable comments; the em dashes in the comments are commas, colons or
  hyphens (`gamma-bridge.test.ts` fails on the character).
- `KpiCard.tsx`: the unavailable-value placeholder reads `n/a` (house rule: n/a, never a dash or zero).
