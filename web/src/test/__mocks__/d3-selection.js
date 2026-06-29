// Mock for d3-selection (ESM-only module that Jest can't parse).
// Provides a chainable selection stub.

const select = (_node) => {
  const selection = {
    call: jest.fn(() => selection),
    on: jest.fn(() => selection),
    attr: jest.fn(() => selection),
  };
  return selection;
};

module.exports = { select };
