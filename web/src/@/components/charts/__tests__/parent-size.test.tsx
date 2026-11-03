import fs from "node:fs";
import path from "node:path";
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { ParentSize } from "@/components/charts/parent-size";

type Observer = { callback: ResizeObserverCallback; target: Element | null };

// jsdom has no ResizeObserver. The hook observes the measured element, and each test
// reports the box it wants through the callback.
let observers: Observer[] = [];

beforeEach(() => {
  observers = [];
  class FakeResizeObserver {
    private readonly entry: Observer;
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, target: null };
      observers.push(this.entry);
    }
    observe(target: Element) {
      this.entry.target = target;
    }
    unobserve() {}
    disconnect() {
      this.entry.target = null;
    }
  }
  window.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
});

function reportBox(width: number, height: number) {
  act(() => {
    for (const o of observers) {
      if (!o.target) continue;
      o.callback(
        [{ contentRect: { width, height, top: 0, left: 0 }, target: o.target } as unknown as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    }
  });
}

describe("ParentSize (charts/parent-size)", () => {
  it("passes the measured box to its children, starting at 0 x 0", async () => {
    const seen: Array<{ width: number; height: number }> = [];
    render(
      <ParentSize>
        {({ width, height }) => {
          seen.push({ width, height });
          return <div data-testid="sized">{`${width}x${height}`}</div>;
        }}
      </ParentSize>,
    );
    expect(seen[0]).toEqual({ width: 0, height: 0 });

    reportBox(320, 180);
    await waitFor(() => expect(screen.getByTestId("sized")).toHaveTextContent("320x180"));
  });

  it("renders its children in flow, not in an absolutely positioned overflow-hidden box", () => {
    // visx 4's ParentSize wraps children in position:absolute; overflow:hidden, so a box whose
    // height comes from its content collapses to 0px. The local one must not.
    const { container } = render(
      <ParentSize className="min-w-0">
        {() => <div data-testid="child">chart</div>}
      </ParentSize>,
    );
    const outer = container.firstElementChild as HTMLElement;
    expect(outer.className).toBe("min-w-0");
    expect(outer.style.width).toBe("100%");
    expect(outer.style.height).toBe("100%");
    expect(outer.style.position).toBe("");
    expect(outer.querySelector('[style*="absolute"]')).toBeNull();
    expect(outer.querySelector('[style*="overflow"]')).toBeNull();
    expect(screen.getByTestId("child").parentElement).toBe(outer);
  });

  it("no app module takes ParentSize or withParentSize from @visx/responsive (visx 4's collapses)", () => {
    const src = path.resolve(__dirname, "../../../../");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") walk(full);
        } else if (/\.(tsx?|mdx?)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
          if (takesCollapsingVisxExport(fs.readFileSync(full, "utf8"))) {
            offenders.push(path.relative(src, full));
          }
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});

/** The exports visx 4 lays out absolutely, in an overflow-hidden box. */
const COLLAPSING_VISX_EXPORTS = ["ParentSize", "withParentSize"];

/**
 * True when a source file takes one of those exports from @visx/responsive: a named,
 * aliased or type import, a namespace import used as R.ParentSize, a re-export, or a
 * dynamic import or require that names one.
 */
function takesCollapsingVisxExport(text: string): boolean {
  const named =
    /\b(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["']@visx\/responsive["']/g;
  for (const match of text.matchAll(named)) {
    const names = match[1]
      .split(",")
      .map((spec) => spec.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]);
    if (names.some((name) => COLLAPSING_VISX_EXPORTS.includes(name))) return true;
  }
  const namespace = /\bimport\s+(?:type\s+)?\*\s*as\s+([\w$]+)\s+from\s*["']@visx\/responsive["']/g;
  for (const match of text.matchAll(namespace)) {
    const alias = match[1].replace(/\$/g, "\\$");
    if (COLLAPSING_VISX_EXPORTS.some((name) => new RegExp(`\\b${alias}\\.${name}\\b`).test(text))) {
      return true;
    }
  }
  if (/\bexport\s*\*\s*(?:as\s+[\w$]+\s+)?from\s*["']@visx\/responsive["']/.test(text)) return true;
  const dynamic = /\b(?:import|require)\(\s*["']@visx\/responsive["']\s*\)/.test(text);
  return (
    dynamic && COLLAPSING_VISX_EXPORTS.some((name) => new RegExp(`\\b${name}\\b`).test(text))
  );
}

describe("takesCollapsingVisxExport (the scan's own cases)", () => {
  it.each([
    { label: "a named import", source: 'import { ParentSize } from "@visx/responsive";', expected: true },
    {
      label: "a multiline named import",
      source: 'import {\n  ParentSize,\n  useParentSize,\n} from "@visx/responsive";',
      expected: true,
    },
    { label: "an aliased import", source: 'import { ParentSize as Sized } from "@visx/responsive";', expected: true },
    { label: "a type-only import", source: 'import type { ParentSize } from "@visx/responsive";', expected: true },
    { label: "an inline type specifier", source: 'import { type ParentSize } from "@visx/responsive";', expected: true },
    { label: "withParentSize", source: 'import { withParentSize } from "@visx/responsive";', expected: true },
    {
      label: "a namespace import of ParentSize",
      source: 'import * as R from "@visx/responsive";\nconst Chart = R.ParentSize;',
      expected: true,
    },
    {
      label: "a namespace import of withParentSize",
      source: 'import * as R from "@visx/responsive";\nconst Chart = R.withParentSize(Inner);',
      expected: true,
    },
    { label: "a named re-export", source: 'export { ParentSize } from "@visx/responsive";', expected: true },
    {
      label: "an aliased re-export",
      source: 'export { withParentSize as wps } from "@visx/responsive";',
      expected: true,
    },
    { label: "a star re-export", source: 'export * from "@visx/responsive";', expected: true },
    {
      label: "a dynamic import",
      source: 'const { ParentSize } = await import("@visx/responsive");',
      expected: true,
    },
    { label: "the hook", source: 'import { useParentSize } from "@visx/responsive";', expected: false },
    {
      label: "a namespace import of the hook",
      source: 'import * as R from "@visx/responsive";\nconst size = R.useParentSize;',
      expected: false,
    },
    {
      label: "the local component",
      source: 'import { ParentSize } from "@/components/charts/parent-size";',
      expected: false,
    },
    {
      label: "the hook with its types",
      source: 'import { useParentSize, type ParentSizeProvidedProps } from "@visx/responsive";',
      expected: false,
    },
  ])("$label (expected $expected)", ({ source, expected }) => {
    expect(takesCollapsingVisxExport(source)).toBe(expected);
  });
});
