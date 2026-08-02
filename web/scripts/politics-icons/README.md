# Politics iconography

A "per-component prompts → consistent icon set → sprite sheet" pipeline for the
politician / influence surfaces, sharing the **exact** warm-duotone `STYLE` of
the housing (`web/scripts/housing-icons/`) and economy
(`web/scripts/economy-icons/`) sets so all three read as one system.

## The subjects are an editorial artefact

`docs/influence-editorial-standards.md` rule 1 names **iconography** as one of
the four ways a page of true facts still carries an imputation, and rule 5
forbids implying a holding's value. These icons render beside **named
parliamentarians**, so the subject wording is a gated decision, not a style one:

- **no money** — no money bag, coin, banknote, dollar sign, cash or price tag.
  Item 10 ("other substantial sources of income") gets an **inbox tray**,
  matching the 📥 precedent in `@/lib/politics/register-items`.
- **no warning / alert / judgement** — no exclamation, siren, warning triangle,
  red flag, eye, detective or surveillance glyph.
- **no legal process** — no gavel, no scales of justice, no courthouse, no
  handcuffs. Every entry here is a lawful, disclosed fact.
- **no winner / loser** — no trophy, medal, podium or crown.

`politics-icon-subjects.test.ts` reads `icon-set.config.mjs` and enforces this
vocabulary, so it survives someone later reaching for a more expressive subject.

## Pieces

| File | Role |
|------|------|
| `icon-set.config.mjs` | Inputs: shared `STYLE` (verbatim from housing, plus the editorial negatives) + `ICONS` (one `{id, subject, group}` per icon). 31 icons across 5 groups: `register` (14), `holder` (3), `funding` (5), `activity` (5), `ui` (4). |
| `generate-icons-openai.mjs` | **Proven direct path**: OpenAI Images API (`gpt-image-1`, transparent PNG) → `out/<id>.png`. Resumable. |
| `pack-sprite.mjs` | Packs `out/*.png` → `web/public/politics-icons/politics-icons.png` + `web/src/@/components/politicians/politics-icons.generated.ts` (typed manifest + name/group unions). |
| `inspect-montage.mjs` | Lays the raw full-res `out/` PNGs out at 256px on white, 8 to a sheet — the **artwork** review, at a size where a currency symbol on a parcel is actually visible. |
| `contact-sheet.mjs` | Renders every icon **from the packed sprite** into one labelled page and screenshots it — the review artefact AND the proof the coords slice correctly. |
| `<PoliticsIcon name=… size=…/>` | `web/src/@/components/politicians/politics-icon.tsx` — slices one icon from the sprite. Server-safe, no protobuf. |

`<PartyMark>` is deliberately **not** part of this pipeline: a party's identity
is a monogram drawn in code, never generated imagery and never a party logo. See
the header of `web/src/@/components/politicians/party-mark.tsx`.

## Generate

```bash
# Direct OpenAI path (proven). Key read-only from ~/projects/shorted/services/.env:
OPENAI_API_KEY=… node web/scripts/politics-icons/generate-icons-openai.mjs
# Subset / regen:
ONLY=gifts,trusts node web/scripts/politics-icons/generate-icons-openai.mjs
FORCE=1 node web/scripts/politics-icons/generate-icons-openai.mjs
# Review the ARTWORK at full res before packing (writes out/review/*.png):
node web/scripts/politics-icons/inspect-montage.mjs
# Pack the sprite + regenerate the typed manifest:
node web/scripts/politics-icons/pack-sprite.mjs
# Review sheet (also proves the sprite slices):
node web/scripts/politics-icons/contact-sheet.mjs [out.png]
```

`QUALITY=low|medium|high` (default `medium`, ~$0.04/icon). 31 icons ≈ $1.30.

**INSPECT EVERY PNG BEFORE PACKING.** The negatives in the prompt reduce the odds
of banned imagery; they do not eliminate them. Open the contact sheet, and
regenerate anything carrying money, a warning mark, a gavel, scales or a trophy
with the offending element named out of the subject:

```bash
ONLY=gifts FORCE=1 node web/scripts/politics-icons/generate-icons-openai.mjs
```

**Add an icon:** append `{ id, subject, group }` to `ICONS` (re-read the bans
first) → generate (only the new one, it's resumable) → pack → reference via
`<PoliticsIcon name="<id>" />` (the id is autocompleted from the generated
manifest). If it is a register item, add it to `REGISTER_ITEM_ICON` in
`@/lib/politics/register-item-icons` — a test asserts that map stays total over
all fourteen items.

The full-res `out/` PNGs are gitignored; the committed sprite is the shipped
asset.
