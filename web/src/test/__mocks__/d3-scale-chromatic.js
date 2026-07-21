// Mock for d3-scale-chromatic (ESM-only module that Jest can't parse without
// extra transform config). Returns a deterministic placeholder color string
// for any interpolation parameter — sufficient for pure helpers under test,
// which don't assert on actual pixel colors.

const interpolateOranges = (t) => `rgb-oranges-${t}`;
const interpolateRdBu = (t) => `rgb-rdbu-${t}`;

module.exports = { interpolateOranges, interpolateRdBu };
