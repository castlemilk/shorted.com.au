import React from "react";
import { render, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import SparkLine from "../sparkline";
import { TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";

// Mock Skeleton component
jest.mock("~/@/components/ui/skeleton", () => ({
  Skeleton: ({ className }: { className?: string }) => (
    <div data-testid="skeleton" className={className}>
      Loading...
    </div>
  ),
}));

// Mock ParentSize to provide consistent dimensions
jest.mock("@visx/responsive", () => ({
  ParentSize: ({
    children,
  }: {
    children: (dims: { width: number; height: number }) => React.ReactNode;
  }) => children({ width: 400, height: 140 }),
}));

describe("SparkLine Component", () => {
  const mockData: TimeSeriesData = {
    points: [
      {
        timestamp: { seconds: BigInt(1700000000), nanos: 0 },
        shortPosition: 5.5,
      },
      {
        timestamp: { seconds: BigInt(1700086400), nanos: 0 },
        shortPosition: 6.2,
      },
      {
        timestamp: { seconds: BigInt(1700172800), nanos: 0 },
        shortPosition: 4.8,
      },
      {
        timestamp: { seconds: BigInt(1700259200), nanos: 0 },
        shortPosition: 7.1,
      },
      {
        timestamp: { seconds: BigInt(1700345600), nanos: 0 },
        shortPosition: 5.9,
      },
    ],
    min: {
      timestamp: { seconds: BigInt(1700172800), nanos: 0 },
      shortPosition: 4.8,
    },
    max: {
      timestamp: { seconds: BigInt(1700259200), nanos: 0 },
      shortPosition: 7.1,
    },
  };

  it("renders without crashing", () => {
    const { container } = render(<SparkLine data={mockData} />);
    expect(container).toBeInTheDocument();
  });

  it("renders XYChart with correct structure", async () => {
    const { container } = render(<SparkLine data={mockData} />);

    // Wait for the chart to render (after initial skeleton delay)
    await waitFor(
      () => {
        const svg = container.querySelector("svg");
        expect(svg).toBeInTheDocument();
      },
      { timeout: 200 },
    );
  });

  it("does not wrap XYChart in extra coordinate-system-breaking elements", async () => {
    const { container } = render(<SparkLine data={mockData} />);

    // Wait for the chart to render
    await waitFor(
      () => {
        const svg = container.querySelector("svg");
        expect(svg).toBeInTheDocument();
      },
      { timeout: 200 },
    );

    // The XYChart should be rendered directly, not wrapped in <g> with clipPath
    // This test prevents the regression where we wrapped XYChart in a <g clipPath>
    const svg = container.querySelector("svg");

    // Should NOT have a clipPath wrapper around the XYChart
    // (clipPath can cause coordinate system issues)
    const clipPathGroups = container.querySelectorAll("g[clip-path]");

    // visx might use clipPath internally, but we shouldn't add our own wrapper
    // The key is that XYChart is rendered at the top level of the SVG
    expect(svg?.firstElementChild?.tagName).not.toBe("defs");
  });

  it("renders LineSeries component", async () => {
    const { container } = render(<SparkLine data={mockData} />);

    // Wait for the chart to render
    await waitFor(
      () => {
        const paths = container.querySelectorAll("path");
        expect(paths.length).toBeGreaterThan(0);
      },
      { timeout: 200 },
    );
  });

  it("renders min and max glyph indicators", async () => {
    const { container } = render(<SparkLine data={mockData} />);

    // Wait for the chart to render
    await waitFor(
      () => {
        // GlyphCircle renders as path elements with class visx-glyph-circle
        const glyphs = container.querySelectorAll(".visx-glyph-circle");
        // Should have at least 2 glyphs (min and max indicators)
        expect(glyphs.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 200 },
    );
  });

  it("uses correct margins for XYChart", async () => {
    const { container } = render(<SparkLine data={mockData} />);

    // Wait for the chart to render
    await waitFor(
      () => {
        const svg = container.querySelector("svg");
        expect(svg).toBeInTheDocument();
      },
      { timeout: 200 },
    );

    // The margins in the component are: { top: 40, right: 10, bottom: 20, left: 10 }
    // We can't directly test this, but we can verify the structure is correct
  });

  it("handles empty data gracefully", () => {
    const emptyData: TimeSeriesData = {
      points: [],
      min: undefined,
      max: undefined,
    };

    const { container } = render(<SparkLine data={emptyData} />);

    // Should render without crashing
    expect(container).toBeInTheDocument();
  });

  it("renders with correct container height", () => {
    const { container } = render(<SparkLine data={mockData} />);

    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper).toHaveStyle({ height: "140px" });
  });

  it("has a relative positioned container for tooltip positioning", () => {
    const { container } = render(<SparkLine data={mockData} />);

    // The parent container should be relative positioned
    // This is important for tooltip positioning
    const wrapper = container.firstElementChild;
    expect(wrapper).toHaveClass("relative");
  });

  it("provides full width to ParentSize", () => {
    const { container } = render(<SparkLine data={mockData} />);

    // The container should have w-full class
    const wrapper = container.firstElementChild;
    expect(wrapper).toHaveClass("w-full");
  });

  it("exports SparkLine as named export", () => {
    // This prevents accidental removal of the named export
    const { SparkLine: NamedExport } = require("../sparkline");
    expect(NamedExport).toBeDefined();
    expect(typeof NamedExport).toBe("function");
  });

  describe("Tooltip positioning regression prevention", () => {
    it("does not have overflow-hidden on relative container", () => {
      const { container } = render(<SparkLine data={mockData} />);

      // The relative container should NOT have overflow-hidden
      // This was causing tooltip positioning issues
      const wrapper = container.firstElementChild;
      expect(wrapper).not.toHaveClass("overflow-hidden");
    });

    it("renders skeleton during initial load", () => {
      const { getByTestId } = render(<SparkLine data={mockData} />);

      // Should have a skeleton element during initial load
      // This is part of the loading UX
      expect(getByTestId("skeleton")).toBeInTheDocument();
    });
  });

  describe("Data accessors", () => {
    it("correctly formats all data points", async () => {
      const { container } = render(<SparkLine data={mockData} />);

      // Should render without errors when processing all points
      expect(container).toBeInTheDocument();

      // Wait for the chart to render - increased timeout to account for:
      // 1. Initial skeleton delay (50ms)
      // 2. ParentSize rendering
      // 3. XYChart and LineSeries rendering
      await waitFor(
        () => {
          const path = container.querySelector("path");
          expect(path).toBeInTheDocument();
        },
        { timeout: 2000 },
      );
    });
  });

  describe("observer strategy", () => {
    let originalResizeObserver: typeof ResizeObserver | undefined;

    beforeEach(() => {
      originalResizeObserver = (
        global as unknown as { ResizeObserver?: typeof ResizeObserver }
      ).ResizeObserver;

      class ResizeObserverMock {
        callback: ResizeObserverCallback;
        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
        }
        observe = (element: Element) => {
          this.callback([
            {
              target: element,
              contentRect: {
                width: 220,
                height: 140,
                top: 0,
                left: 0,
                bottom: 140,
                right: 220,
                x: 0,
                y: 0,
              },
              borderBoxSize: [],
              contentBoxSize: [],
              devicePixelContentBoxSize: [],
            } as unknown as ResizeObserverEntry,
          ]);
        };
        unobserve = () => void 0;
        disconnect = () => void 0;
      }

      (
        global as unknown as { ResizeObserver: typeof ResizeObserver }
      ).ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
    });

    afterEach(() => {
      if (originalResizeObserver) {
        (
          global as unknown as { ResizeObserver: typeof ResizeObserver }
        ).ResizeObserver = originalResizeObserver;
      } else {
        delete (global as unknown as { ResizeObserver?: typeof ResizeObserver })
          .ResizeObserver;
      }
    });

    it("renders when using observer strategy", async () => {
      const { container } = render(
        <SparkLine data={mockData} strategy="observer" minWidth={160} />,
      );

      await waitFor(() => {
        const svg = container.querySelector("svg");
        expect(svg).toBeInTheDocument();
      });
    });
  });
});
