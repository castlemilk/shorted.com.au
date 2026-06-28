// Mock for d3-zoom (ESM-only module that Jest can't parse).
// Provides a chainable zoom-behaviour stub.

const zoom = () => {
  const behavior = () => behavior;
  behavior.scaleExtent = jest.fn(() => behavior);
  behavior.on = jest.fn(() => behavior);
  return behavior;
};

module.exports = { zoom };
