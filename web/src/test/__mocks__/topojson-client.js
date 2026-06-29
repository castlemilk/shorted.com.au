// Mock for topojson-client (ESM-only module that Jest can't parse).
// `feature()` returns an empty FeatureCollection by default.

const feature = (_topology, _object) => ({ type: "FeatureCollection", features: [] });

module.exports = { feature };
