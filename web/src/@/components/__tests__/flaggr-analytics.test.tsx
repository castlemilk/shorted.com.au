import { runInNewContext } from "node:vm";
import { flaggrAnalyticsBootstrap, FlaggrAnalytics } from "../flaggr-analytics";

function runBootstrap(hostname: string, doNotTrack = "0", userAgent = "Mozilla/5.0", webdriver = false) {
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
  const context = { window: { location: { hostname } }, navigator: { doNotTrack, userAgent, webdriver }, document };
  runInNewContext(flaggrAnalyticsBootstrap, context);
  return { scripts, context };
}

describe("Flaggr browser analytics", () => {
  it.each(["shorted.com.au", "www.shorted.com.au"])("loads the pinned collector on %s", (hostname) => {
    const { scripts, context } = runBootstrap(hostname);
    expect(scripts).toHaveLength(1);
    const script = scripts[0]!;
    expect(script.src).toBe("https://cdn.flaggr.dev/a-0.1.9.js");
    expect(script.integrity).toBe("sha384-UbokEwOv+WfuKvg33yULNZRqXEMFKfrK39J4QItWznOG1IXviooN+w65ec5D6izH");
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
