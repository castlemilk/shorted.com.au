# Housing iconography flow

A reusable "per-component prompts → consistent icon set → sprite sheet" pipeline,
driven through the **brandbrain `flow-orchestrator` MCP server**. Produces the
warm-duotone icons used across the housing surface (metrics, profile sections,
dashboard tiles, dropdowns).

Design spec: `docs/superpowers/specs/2026-07-02-housing-iconography-design.md`.

## Pieces

| File | Role |
|------|------|
| `icon-set.config.mjs` | The inputs: shared `STYLE` + `ICONS` (one `{id, subject, group}` per icon). |
| `generate-icons.mjs` | The flow: drives the brandbrain MCP over stdio → builds a graph (shared `style` node → per-icon `prompt→generate→output`) → runs → saves `out/<id>.png`. |
| `pack-sprite.mjs` | Packs `out/*.png` → `web/public/housing-icons/housing-icons.png` + generates `web/src/@/components/housing/housing-icons.generated.ts` (typed manifest). |
| `<HousingIcon name=… size=…/>` | `web/src/@/components/housing/housing-icon.tsx` — slices one icon from the sprite. |

## Prerequisites

- The brandbrain flow-orchestrator MCP built at
  `~/projects/brandbrain/mcp/flow-orchestrator/dist/index.js`
  (override with `FLOW_MCP_ENTRY`).
- Authenticated to the brandbrain backend (prod by default). Check with the MCP's
  `whoami`; if not authed, run its `login_brandbrain` once. Generation runs on the
  backend (OpenAI `gpt-image-1`) — it **costs money** (~a few cents/icon).

## Regenerate / extend

```bash
# Generate every missing icon (skips ones already in out/):
MODE=live node web/scripts/housing-icons/generate-icons.mjs
# Regenerate a subset (e.g. after editing a subject prompt):
MODE=live FORCE=1 ONLY=median-price,school node web/scripts/housing-icons/generate-icons.mjs
# Validate the graph without spending:
MODE=mock node web/scripts/housing-icons/generate-icons.mjs
# Pack the sprite + regenerate the typed manifest:
node web/scripts/housing-icons/pack-sprite.mjs
```

**Add an icon:** append `{ id, subject, group }` to `ICONS` → run generate (only
the new one) → run pack → reference it via `<HousingIcon name="<id>" />` (the id is
autocompleted from the generated manifest).

The full-res `out/` PNGs are gitignored (~1.4MB each); the committed sprite is the
shipped asset.
