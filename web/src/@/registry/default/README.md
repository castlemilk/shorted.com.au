# `registry/default` — vendored mdxcn figures

These directories are copied from the **mdxcn** shadcn registry
(<https://mdxcn.dev>, MIT, `keshav-exe/mdxcn`), the way the shadcn CLI would
place them, minus the CLI. They are the ASCII-framed, lightly animated MDX
figures the blog uses (`GraphStat`, `GraphRank`, `GraphSlope`, `Callout`, …).
Only `graph-frame` is shared by the rest; the Comark/Knap adapters, timers,
uptime and calendar figures were deliberately not vendored.

## Why not the CLI

mdxcn targets Tailwind v4: its registry ships `@utility` blocks and
`@theme` colour tokens. This project is on Tailwind 3.4, so the CLI's CSS step
would write syntax our build cannot read. The port lives in
`src/styles/globals.css` (the `.graph-frame` / `.graph-rule` / `.graph-rule-y`
classes and the `--graph-*` variables, mapped onto the site palette rather than
mdxcn's default blue) and `tailwind.config.ts` (`graph-accent`, `graph-muted`,
`graph-frame`, … as colours). The component sources themselves use only
utilities 3.4 has.

## Adding another figure

1. `curl -sL https://mdxcn.dev/r/<slug>.json` and copy each `files[].path`
   under `src/@/…` with the provenance header the others carry.
2. Check its imports: anything under `@/registry/default/` other than
   `graph-frame` must be vendored too; the only npm dependency is `motion`.
3. Register it in `src/@/components/blog/mdx-components.tsx`.
4. The newsroom palette (`components/news/mdx/`) is separate and has a
   three-place sync rule — see `.claude/skills/newsroom/SKILL.md` before adding
   a figure there. Note mdxcn's `Stat` child collides with that palette's
   `Stat`.

Upstream motion rules, kept: opacity and transform only, ~220 ms, no loops,
`useReducedMotion` respected.

## Authoring form (this matters)

In `_blogs` posts, write figure data as the markdown-list form inside the
figure — `- 29.7% Fawkner`, bold for the accent row, ` — ` before a hint —
with a blank line after the opening tag. Neither `items={[...]}` props nor
`<Stat>`/`<Rank>` markers survive the React Server Components boundary here
(see `components/blog/mdxcn-figures.tsx`); the list form does, because it
reaches the parent as host `<ul>/<li>` elements.
