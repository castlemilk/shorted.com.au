# Economy iconography

A "per-component prompts → consistent icon set → sprite sheet" pipeline for the
`/economy` surface, sharing the **exact** warm-duotone `STYLE` of the housing
icon set (`web/scripts/housing-icons/`) so the two sets read as one system.

Design spec: `docs/superpowers/specs/2026-07-21-economy-state-pages-design.md` §B.

## Pieces

| File | Role |
|------|------|
| `icon-set.config.mjs` | Inputs: shared `STYLE` (verbatim from housing) + `ICONS` (one `{id, subject, group}` per icon). 24 icons: 14 stat/chart headers + 10 SITC commodities. |
| `generate-icons-openai.mjs` | **Proven direct path**: OpenAI Images API (`gpt-image-1`, transparent PNG) → `out/<id>.png`. Resumable. |
| `generate-icons.mjs` | Alternative flow path via the brandbrain `flow-orchestrator` MCP (same graph shape as housing-icons). |
| `pack-sprite.mjs` | Packs `out/*.png` → `web/public/economy-icons/economy-icons.png` + `web/src/@/components/economy/economy-icons.generated.ts` (typed manifest). |
| `<EconomyIcon name=… size=…/>` | `web/src/@/components/economy/economy-icon.tsx` — slices one icon from the sprite. |

## Generate

```bash
# Direct OpenAI path (proven). Key read-only from ~/projects/shorted/services/.env:
OPENAI_API_KEY=… node web/scripts/economy-icons/generate-icons-openai.mjs
# Subset / regen:
ONLY=food,chemicals node web/scripts/economy-icons/generate-icons-openai.mjs
FORCE=1 node web/scripts/economy-icons/generate-icons-openai.mjs
# Pack the sprite + regenerate the typed manifest:
node web/scripts/economy-icons/pack-sprite.mjs
```

`QUALITY=low|medium|high` (default `medium`, ~$0.04/icon). ~24 icons ≈ $1.

**Add an icon:** append `{ id, subject, group }` to `ICONS` → generate (only the
new one, it's resumable) → pack → reference via `<EconomyIcon name="<id>" />`
(the id is autocompleted from the generated manifest). For a new SITC commodity,
also add its `icon` to `SITC_PRODUCTS` in `top-exports.tsx`.

The full-res `out/` PNGs are gitignored; the committed sprite is the shipped asset.
