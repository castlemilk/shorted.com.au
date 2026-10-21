# Stock picker editorial art

One warm-duotone scene per strategy, drawn through the **brandbrain
`flow-orchestrator` MCP** in the housing banners' language, and shown behind
the strategy page's faceplate (`/picks/<strategy>`), as a plate on the `/picks`
rack, and as the scene behind the strategy's share card. Each scene is the
strategy's engraved glyph (`web/src/@/lib/strategies/glyphs.ts`) at scene
scale: the mechanism the strategy waits for, never a stock chart, never a
person.

A strategy that is not in the manifest shows its **generative scene** instead
(`web/src/@/lib/strategies/scenes.ts`: the same mechanism, drawn as hairline
SVG on the server and animated on a canvas in the browser), so this pipeline
is optional and can be run one strategy at a time; baked art replaces the
scene wherever it exists.

## Pieces

| File | Role |
|------|------|
| `art-set.config.mjs` | The inputs: shared `STYLE`, one `SCENES` entry per strategy id, the generate `TARGET`. |
| `generate-art.mjs` | The flow: drives the brandbrain MCP through `web/scripts/lib/brandbrain-flow.mjs` (the one shared driver) and saves `out/<id>.png`. |
| `generate-art-openai.mjs` | The same scenes through the OpenAI Images API directly, for when the MCP is not built or not logged in. |
| `bake.mjs` | `out/*.png` -> `web/public/picks-art/<id>.{light,dark}.avif`, `web/public/picks-art/og/<id>.jpg`, and the manifest `web/src/@/lib/strategies/art.generated.ts`. |
| `lib/strategies/art.ts` | Reads the manifest: `strategyArt(slug)` is the three URLs (with the content hash) or null. |
| `components/picks/strategy-art.tsx` | `StrategyArtBand` (the page header) and `StrategyArtPlate` (the hub row); both render nothing without art. |

## Prerequisites

- The brandbrain flow-orchestrator MCP built at
  `~/projects/brandbrain/mcp/flow-orchestrator/dist/index.js` (override with
  `FLOW_MCP_ENTRY`), authenticated to the brandbrain backend: its `whoami`
  must report a user; if not, run its `login_brandbrain` once. Generation runs
  on the backend (OpenAI `gpt-image-1`) and **costs money** (about $0.06 a
  scene).
- Or `OPENAI_API_KEY` in the environment for the direct fallback.
- `sharp` (a web dependency) for the bake.

## Generate, bake, ship

```bash
# Validate the graph without spending:
MODE=mock node web/scripts/picks-art/generate-art.mjs
# Generate every scene without a master (skips ones already in out/):
MODE=live node web/scripts/picks-art/generate-art.mjs
# Or one scene, regenerated:
MODE=live FORCE=1 ONLY=canslim node web/scripts/picks-art/generate-art.mjs
# Without the MCP:
OPENAI_API_KEY=... node web/scripts/picks-art/generate-art-openai.mjs

# Bake the bands, the share-card scenes and the manifest:
node web/scripts/picks-art/bake.mjs

# Look at it: the strategy page header, the hub row, and
#   /picks/<strategy>/opengraph-image
npm --prefix web run dev
```

Commit `web/public/picks-art/` and `art.generated.ts` together: the manifest's
hash is the cache key the URLs carry, so a regenerated scene is never served
stale, and a strategy whose master is missing at bake time is dropped from
the manifest (and its baked files deleted) rather than left pointing at
nothing.

## Judging a scene

Squint at the hub: five plates must be told apart by silhouette alone, as the
glyphs are. On the strategy page the upper-left must stay calm under the H1
and the provenance plate (the scrim helps, it does not rescue a busy corner).
Reject anything with text, a candlestick, a person, or a frame; regenerate
that one with `FORCE=1 ONLY=<id>`. The full-res `out/` masters are gitignored.
