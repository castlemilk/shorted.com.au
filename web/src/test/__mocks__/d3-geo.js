/* eslint-disable @typescript-eslint/no-unused-vars */
// Mock for d3-geo (ESM-only module that Jest can't parse).
// Provides chainable stubs so components importing d3-geo can be unit-tested.

const makeProjection = () => {
  const projection = (coords) => coords;
  projection.fitSize = jest.fn(() => projection);
  projection.fitExtent = jest.fn(() => projection);
  projection.scale = jest.fn(() => projection);
  projection.translate = jest.fn(() => projection);
  return projection;
};

const geoMercator = () => makeProjection();

// With a context, walk the feature's rings through it (rounding is the
// context's job) so the compact serialiser can be exercised; without one,
// return the fixed string the older component tests expect.
const geoPath = (_projection, context) => {
  const path = (feature) => {
    if (!context) return "M0,0";
    const geom = feature && feature.geometry;
    const rings = [];
    if (geom && geom.type === "Polygon") rings.push(...geom.coordinates);
    if (geom && geom.type === "MultiPolygon") for (const poly of geom.coordinates) rings.push(...poly);
    context.beginPath();
    for (const ring of rings) {
      // Like d3's geoStream: a polygon ring's closing coordinate is not streamed.
      ring.slice(0, -1).forEach(([x, y], i) => (i === 0 ? context.moveTo(x, y) : context.lineTo(x, y)));
      context.closePath();
    }
    return undefined;
  };
  path.projection = jest.fn(() => path);
  return path;
};

module.exports = { geoMercator, geoPath };
