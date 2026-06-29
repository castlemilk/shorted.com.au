/* eslint-disable @typescript-eslint/no-unused-vars */
// Mock for d3-geo (ESM-only module that Jest can't parse).
// Provides chainable stubs so components importing d3-geo can be unit-tested.

const makeProjection = () => {
  const projection = (coords) => coords;
  projection.fitSize = jest.fn(() => projection);
  projection.scale = jest.fn(() => projection);
  projection.translate = jest.fn(() => projection);
  return projection;
};

const geoMercator = () => makeProjection();

const geoPath = (_projection) => {
  const path = (_feature) => "M0,0";
  path.projection = jest.fn(() => path);
  return path;
};

module.exports = { geoMercator, geoPath };
