// Layout font downloads are irrelevant to this functional journey. Next's
// existing test hook keeps Google Fonts out of the otherwise local test stack.
module.exports = new Proxy(
  {},
  {
    get: () =>
      "@font-face { font-family: 'IBM Plex Mono'; src: local('monospace'); font-weight: 400 700; font-style: normal; }",
  },
);
