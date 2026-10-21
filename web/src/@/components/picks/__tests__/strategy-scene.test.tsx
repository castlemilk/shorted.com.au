import { act, render } from "@testing-library/react";

import { SceneSvg, StrategyScene } from "../strategy-scene";
import { StrategySceneCanvas, sceneStageOf } from "../strategy-scene-canvas";
import { sceneStill } from "~/@/lib/strategies/scenes";

jest.mock("../strategy-scene-lazy", () => ({
  StrategySceneLazy: ({ slug, variant }: { slug: string; variant: string }) => (
    <canvas data-scene-canvas={variant} data-slug={slug} />
  ),
}));

describe("StrategyScene", () => {
  it("renders the still as inline SVG with the lazy canvas beside it, decoratively", () => {
    const { container } = render(
      <StrategyScene slug="zanger-breakout" variant="band" className="absolute inset-0" />,
    );
    const host = container.firstElementChild!;
    expect(host).toHaveAttribute("aria-hidden", "true");
    expect(host).toHaveAttribute("data-strategy-scene", "zanger-breakout");
    expect(host.className).toContain("strategy-scene");
    const svg = host.querySelector("svg")!;
    expect(svg).toHaveAttribute("viewBox", "0 0 360 120");
    expect(svg).toHaveAttribute("preserveAspectRatio", "xMidYMid slice");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg.querySelectorAll("path").length).toBe(sceneStill("zanger-breakout", "band").paths.length);
    expect(svg.textContent).toBe("");
    // The canvas follows the still, so it paints over it.
    expect(host.lastElementChild).toHaveAttribute("data-scene-canvas", "band");
  });

  it("draws strokes in the theme's text colours, non-scaling, and fills in currentColor", () => {
    const { container } = render(<SceneSvg frame={sceneStill("canslim", "plate")} />);
    const paths = [...container.querySelectorAll("path")];
    const strokes = paths.filter((p) => p.getAttribute("stroke") === "currentColor");
    const fills = paths.filter((p) => p.getAttribute("fill") === "currentColor");
    expect(strokes.length).toBeGreaterThan(0);
    expect(fills.length).toBeGreaterThan(0);
    for (const p of strokes) {
      expect(p).toHaveAttribute("vector-effect", "non-scaling-stroke");
      expect(p.getAttribute("fill")).toBe("none");
      expect(p.getAttribute("class")).toMatch(/^text-(foreground|primary|secondary|accent|muted-foreground)$/);
    }
    for (const p of fills) expect(p.getAttribute("stroke")).toBe("none");
    // The dashed prior-high line keeps its dash.
    expect(paths.some((p) => p.getAttribute("stroke-dasharray") === "4 3")).toBe(true);
  });

  it("renders nothing for a strategy without a scene", () => {
    const { container } = render(<StrategyScene slug="nope" variant="band" />);
    expect(container.innerHTML).toBe("");
  });
});

describe("StrategySceneCanvas", () => {
  it("stops and restores the still when reduced motion changes live, then resumes safely", () => {
    const matchMedia = window.matchMedia;
    const listeners = new Set<() => void>();
    const preference = {
      matches: false,
      addEventListener: jest.fn((_name: string, callback: () => void) => listeners.add(callback)),
      removeEventListener: jest.fn((_name: string, callback: () => void) => listeners.delete(callback)),
    };
    window.matchMedia = jest.fn().mockReturnValue(preference) as unknown as typeof window.matchMedia;
    const getContext = jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const request = jest.spyOn(window, "requestAnimationFrame").mockReturnValue(42);
    const cancel = jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const view = render(<div><StrategySceneCanvas slug="canslim" variant="plate" /></div>);
    try {
      expect(request).toHaveBeenCalledTimes(1);
      view.container.firstElementChild?.setAttribute("data-scene-live", "");
      act(() => { preference.matches = true; listeners.forEach((callback) => callback()); });
      expect(cancel).toHaveBeenCalledWith(42);
      expect(view.container.firstElementChild).not.toHaveAttribute("data-scene-live");
      expect(request).toHaveBeenCalledTimes(1);
      act(() => { preference.matches = false; listeners.forEach((callback) => callback()); });
      expect(request).toHaveBeenCalledTimes(2);
      view.unmount();
      expect(listeners.size).toBe(0);
      expect(cancel).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
      getContext.mockRestore(); request.mockRestore(); cancel.mockRestore();
      window.matchMedia = matchMedia;
    }
  });
  it("mounts a decorative canvas and stays quiet where there is no 2D context", () => {
    const getContext = jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
    const { container } = render(
      <div className="strategy-scene">
        <StrategySceneCanvas slug="canslim" variant="plate" />
      </div>,
    );
    const canvas = container.querySelector("canvas")!;
    expect(canvas).toHaveAttribute("aria-hidden", "true");
    expect(canvas).toHaveAttribute("data-scene-canvas", "plate");
    // No context, no frame, no hand-over: the still stays visible.
    expect(container.firstElementChild).not.toHaveAttribute("data-scene-live");
    expect(getContext).toHaveBeenCalledWith("2d");
    getContext.mockRestore();
  });

  it("draws nothing under prefers-reduced-motion", () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = jest.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    const getContext = jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
    render(<StrategySceneCanvas slug="canslim" variant="plate" />);
    expect(getContext).not.toHaveBeenCalled();
    getContext.mockRestore();
    window.matchMedia = matchMedia;
  });
});

describe("sceneStageOf", () => {
  it("reads the pointer on the nearest data-scene-stage ancestor, else the canvas itself", () => {
    const { container } = render(
      <section data-scene-stage="">
        <div>
          <canvas data-testid="a" />
        </div>
      </section>,
    );
    const canvas = container.querySelector("canvas")!;
    expect(sceneStageOf(canvas)).toBe(container.querySelector("section"));
    const alone = render(<canvas />).container.querySelector("canvas")!;
    expect(sceneStageOf(alone)).toBe(alone);
  });
});
