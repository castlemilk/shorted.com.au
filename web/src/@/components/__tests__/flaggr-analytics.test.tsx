import { runInNewContext } from "node:vm";
import { flaggrAnalyticsBootstrap, FlaggrAnalytics } from "../flaggr-analytics";

function runBootstrap(
  hostname: string,
  doNotTrack = "0",
  userAgent = "Mozilla/5.0",
  webdriver = false,
  page: { pathname?: string; search?: string; width?: number; height?: number } = {},
) {
  const scripts: Array<HTMLScriptElement> = [];
  const document = {
    getElementById: (id: string) => scripts.find((script) => script.id === id),
    createElement: () => {
      const attributes: Record<string, string> = {};
      return {
        setAttribute: (name: string, value: string) => { attributes[name] = value; },
        getAttribute: (name: string) => attributes[name] ?? null,
      } as HTMLScriptElement;
    },
    head: { appendChild: (script: HTMLScriptElement) => scripts.push(script) },
  };
  const context = {
    window: {
      location: { hostname, pathname: page.pathname ?? "/", search: page.search ?? "" },
      innerWidth: page.width ?? 1024,
      innerHeight: page.height ?? 768,
    },
    URLSearchParams,
    navigator: { doNotTrack, userAgent, webdriver },
    document,
  };
  runInNewContext(flaggrAnalyticsBootstrap, context);
  return { scripts, context };
}

describe("Flaggr browser analytics", () => {
  it.each(["shorted.com.au", "www.shorted.com.au"])("loads the pinned collector on %s", (hostname) => {
    const { scripts, context } = runBootstrap(hostname);
    expect(scripts).toHaveLength(1);
    const script = scripts[0]!;
    expect(script.src).toBe("https://cdn.flaggr.dev/a-0.1.10.js");
    expect(script.integrity).toBe("sha384-dV83vmVumSE44iklJMarN8vFcEXjp1j5pu6ONnIm6wI1rfz00RxjS82bBRPUhzrQ");
    expect(script.crossOrigin).toBe("anonymous");
    expect(script.async).toBe(true);
    expect(script.getAttribute("data-site-id")).toBe("site_869df5560db33f777d73f0f9");
    expect(script.getAttribute("data-track-errors")).toBe("true");
    expect(script.getAttribute("data-track-clicks")).toBeNull();

    runInNewContext(flaggrAnalyticsBootstrap, context);
    expect(scripts).toHaveLength(1);
  });

  it.each(["localhost", "preview.shorted.com.au", "shorted.com.au.example.com"])("does not load on %s", (hostname) => {
    expect(runBootstrap(hostname).scripts).toHaveLength(0);
  });

  it("honours Do Not Track before loading the collector", () => {
    expect(runBootstrap("shorted.com.au", "1").scripts).toHaveLength(0);
  });

  it("excludes the marked production smoke-test browser", () => {
    expect(runBootstrap("shorted.com.au", "0", "Mozilla/5.0 Shorted-E2E/1.0").scripts).toHaveLength(0);
  });

  it("excludes WebDriver-controlled browsers", () => {
    expect(runBootstrap("shorted.com.au", "0", "Mozilla/5.0", true).scripts).toHaveLength(0);
  });

  it("excludes GoogleOther crawler traffic without excluding Android Chrome", () => {
    const androidChrome = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36";
    expect(runBootstrap("shorted.com.au", "0", `${androidChrome} (compatible; GoogleOther)`).scripts).toHaveLength(0);
    expect(runBootstrap("shorted.com.au", "0", androidChrome).scripts).toHaveLength(1);
  });

  it("excludes the observed automated ownership-connections traffic", () => {
    const page = {
      pathname: "/ownership/connections",
      search: "?+Components=&+Development=&+Services=&sector=Banks&sel=connection:index_manager%3EMedia",
      width: 1366,
      height: 1366,
    };
    expect(runBootstrap("shorted.com.au", "0", "Mozilla/5.0", false, page).scripts).toHaveLength(0);
  });

  it("keeps ordinary browsers and valid ownership links in the analytics", () => {
    const malformed = "?+Components=&+Development=&+Services=&sel=connection:index_manager%3EMedia";
    const square = { width: 1366, height: 1366 };
    const visits = [
      { ...square, pathname: "/ownership/connections", search: "?sector=Food%2C+Beverage+%26+Tobacco&sel=connection:index_manager%3EMedia" },
      { ...square, pathname: "/ownership/connections", search: "?+Components=&+Development=&+Services=&sector=Banks" },
      { ...square, pathname: "/ownership/connections", search: "?+Components=&+Development=&sel=connection:index_manager%3EMedia" },
      { pathname: "/ownership/connections", search: malformed, width: 1366, height: 768 },
      { ...square, pathname: "/top", search: malformed },
    ];
    for (const page of visits) expect(runBootstrap("shorted.com.au", "0", "Mozilla/5.0", false, page).scripts).toHaveLength(1);
  });

  it("cannot prevent rendering when script insertion fails", () => {
    expect(() => runInNewContext(flaggrAnalyticsBootstrap, {
      window: { location: { hostname: "shorted.com.au" } },
      navigator: { doNotTrack: "0", userAgent: "Mozilla/5.0" },
      document: { getElementById: () => null, createElement: () => { throw new Error("blocked"); } },
    })).not.toThrow();
  });

  it("renders the bootstrap for the document head", () => {
    const element = FlaggrAnalytics();
    expect(element.props.id).toBe("flaggr-analytics-bootstrap");
    expect(element.props.dangerouslySetInnerHTML.__html).toBe(flaggrAnalyticsBootstrap);
  });
});
