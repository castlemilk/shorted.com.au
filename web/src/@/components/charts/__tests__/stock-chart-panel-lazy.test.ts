/** @jest-environment node */

// The Overview's chart module and the panel's code. In the browser, on the
// Overview, the module starts fetching the panel as soon as it runs. It never
// does on the server, because the panel reaches @connectrpc, which must not be
// evaluated during server rendering (CLAUDE.md, "SSR Issues with
// @connectrpc/connect"). Nor on any other tab: Next runs the Overview's client
// modules there too, whenever a tab resolves a shared module through the
// Overview's chunk lists, and an unconditional fetch put the chart's code back
// on Financials and Community.

const panelLoaded = jest.fn();
jest.mock("../StockChartPanel", () => {
  panelLoaded();
  return { StockChartPanel: () => null };
});

/** Lets a started import() finish requiring its module. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Runs the module afresh, in the browser at `pathname` or (null) on the server.
 * The async form keeps the fresh registry until a started import() has
 * required its module, so each run loads the panel anew or not at all. (With
 * the synchronous form the import() resolved against the shared registry, which
 * loaded the panel once for the whole file, and the "does not load" cases
 * passed whatever the module did.)
 */
async function runModuleAt(pathname: string | null) {
  const global = globalThis as { window?: unknown };
  if (pathname !== null) global.window = { location: { pathname } };
  try {
    await jest.isolateModulesAsync(async () => {
      require("../stock-chart-panel-lazy");
      await settle();
    });
  } finally {
    delete global.window;
  }
}

describe("stock-chart-panel-lazy", () => {
  beforeEach(() => panelLoaded.mockClear());

  it("never loads the panel on the server", async () => {
    await runModuleAt(null);
    expect(panelLoaded).not.toHaveBeenCalled();
  });

  // Started when the module runs, during hydration, rather than when the panel
  // first renders after it: on a throttled phone that is the difference between
  // the chart landing when it did as a first-load chunk and 0.2s later.
  it.each(["/shorts/BHP", "/shorts/BHP/"])(
    "starts loading the panel as soon as it runs on the Overview (%s), before anything renders it",
    async (pathname) => {
      await runModuleAt(pathname);
      expect(panelLoaded).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "/shorts/BHP/financials",
    "/shorts/BHP/community",
    "/shorts/BHP/community/thread-1",
    "/shorts/BHP/company",
    "/shorts/BHP/news",
  ])("does not load the panel when it runs on %s", async (pathname) => {
    await runModuleAt(pathname);
    expect(panelLoaded).not.toHaveBeenCalled();
  });
});
