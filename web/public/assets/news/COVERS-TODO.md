# Placeholder covers

These three posts reuse an existing cover because bespoke images could not be
generated in the authoring session (no OPENAI_API_KEY available locally).
Replace before they get much traffic — a duplicated cover weakens both the
article card and the OG/social preview, which is the entire point of having one.

| Slug | Borrowed from |
|---|---|
| `droneshield-dro-short-interest` | `asx-short-squeeze-candidates` (blog) |
| `asx-energy-shorts-woodside-rotation` | `hormuz-asx-energy-deep-dive` (blog) |
| `australian-house-prices-rents-supply-2026` | `asx-sectors-most-shorted` (blog) |

To generate the real ones (needs `OPENAI_API_KEY`):

```bash
cd scripts/image-gen
npm run pipeline -- --slug=droneshield-dro-short-interest
npm run pipeline -- --slug=asx-energy-shorts-woodside-rotation
npm run pipeline -- --slug=australian-house-prices-rents-supply-2026
```

Style anchor for the set is the squeeze-spring cover — curated macro still-life,
not stock-photo or AI-slop.
