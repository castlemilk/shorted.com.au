import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// Mock Connect RPC before any imports
jest.mock("@connectrpc/connect", () => ({
  createClient: jest.fn(() => ({
    getStockData: jest.fn(),
  })),
}));

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));

import Chart from "../chart";

// Mock the client API
jest.mock("~/@/lib/client-api", () => ({
  fetchStockDataClient: jest.fn(),
}));

jest.mock("react", () => ({
  ...jest.requireActual("react"),
  cache: (fn: any) => fn,
}));
jest.mock("@visx/responsive/lib/components/ParentSize", () => ({
  __esModule: true,
  default: ({ children }: any) => children({ width: 800, height: 400 }),
}));

// Mock visx tooltip hooks
jest.mock("@visx/tooltip", () => ({
  useTooltip: jest.fn(() => ({
    showTooltip: jest.fn(),
    hideTooltip: jest.fn(),
    tooltipOpen: false,
    tooltipData: null,
    tooltipLeft: 0,
    tooltipTop: 0,
  })),
  useTooltipInPortal: jest.fn(() => ({
    containerRef: { current: null },
    TooltipInPortal: ({ children }: any) => <div>{children}</div>,
    containerBounds: { left: 0, top: 0, width: 0, height: 0 },
  })),
}));

const clearMock = jest.fn();
const resetMock = jest.fn();

jest.mock("../unified-brush-chart", () => ({
  __esModule: true,
  default: React.forwardRef(({ data, period }: any, ref: any) => {
    React.useImperativeHandle(ref, () => ({
      clear: clearMock,
      reset: resetMock,
    }));
    return (
      <div data-testid="brush-chart">
        <div>Period: {period}</div>
        <div>Data points: {data?.points?.length || 0}</div>
      </div>
    );
  }),
}));

jest.mock("../toggle-group", () => ({
  ToggleGroup: ({ children, onValueChange }: any) => (
    <div data-testid="toggle-group" onClick={() => onValueChange("1y")}>
      {children}
    </div>
  ),
  ToggleGroupItem: ({ children, value }: any) => (
    <button data-testid={`toggle-${value}`} value={value}>
      {children}
    </button>
  ),
}));

jest.mock("../button", () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));

jest.mock("../skeleton", () => ({
  Skeleton: () => <div data-testid="skeleton">Loading...</div>,
}));

const { fetchStockDataClient } = require("~/@/lib/client-api");
const mockFetchStockDataClient = fetchStockDataClient as jest.MockedFunction<
  typeof fetchStockDataClient
>;

describe("Chart Component", () => {
  const mockData = {
    points: [
      { date: new Date("2023-01-01"), value: 10.5 },
      { date: new Date("2023-01-02"), value: 11.2 },
      { date: new Date("2023-01-03"), value: 10.8 },
      { date: new Date("2023-01-04"), value: 12.1 },
    ],
    productCode: "CBA",
    max: 12.1,
    min: 10.5,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    clearMock.mockClear();
    resetMock.mockClear();
    // Default mock - resolve with data
    mockFetchStockDataClient.mockResolvedValue(mockData as any);
  });

  it("renders chart with stock data", async () => {
    render(<Chart stockCode="CBA" />);

    await waitFor(() => {
      expect(screen.getByTestId("brush-chart")).toBeInTheDocument();
    });
    expect(screen.getByText("Data points: 4")).toBeInTheDocument();
  });

  it("displays loading state initially", () => {
    mockFetchStockDataClient.mockImplementation(
      () => new Promise(() => {}) // Never resolves
    );

    render(<Chart stockCode="CBA" />);

    // Should show skeleton when loading
    expect(screen.getByTestId("skeleton")).toBeInTheDocument();
  });

  it("handles error state", async () => {
    mockFetchStockDataClient.mockRejectedValue(new Error("Failed to fetch data"));

    render(<Chart stockCode="CBA" />);

    // Should show error message
    await waitFor(() => {
      expect(
        screen.getByText("Error loading data: Failed to fetch data"),
      ).toBeInTheDocument();
    });
  });

  it("renders period toggle buttons", async () => {
    render(<Chart stockCode="CBA" />);

    await waitFor(() => {
      expect(screen.getByTestId("brush-chart")).toBeInTheDocument();
    });

    expect(screen.getByTestId("toggle-1m")).toHaveTextContent("1M");
    expect(screen.getByTestId("toggle-3m")).toHaveTextContent("3M");
    expect(screen.getByTestId("toggle-6m")).toHaveTextContent("6M");
    expect(screen.getByTestId("toggle-1y")).toHaveTextContent("1Y");
    expect(screen.getByTestId("toggle-2y")).toHaveTextContent("2Y");
    expect(screen.getByTestId("toggle-5y")).toHaveTextContent("5Y");
    expect(screen.getByTestId("toggle-10y")).toHaveTextContent("10Y");
    expect(screen.getByTestId("toggle-max")).toHaveTextContent("max");
  });

  it("changes period when toggle is clicked", async () => {
    render(<Chart stockCode="CBA" />);

    await waitFor(() => {
      expect(screen.getByTestId("brush-chart")).toBeInTheDocument();
    });

    const toggleGroup = screen.getByTestId("toggle-group");
    fireEvent.click(toggleGroup);

    await waitFor(() => {
      expect(mockFetchStockDataClient).toHaveBeenCalledWith("CBA", "1y");
    });
  });

  it("renders clear and reset buttons", async () => {
    render(<Chart stockCode="CBA" />);

    await waitFor(() => {
      expect(screen.getByTestId("brush-chart")).toBeInTheDocument();
    });

    expect(screen.getByText("Clear")).toBeInTheDocument();
    expect(screen.getByText("Reset")).toBeInTheDocument();
  });

  it("calls clear method when Clear button is clicked", async () => {
    render(<Chart stockCode="CBA" />);

    await waitFor(() => {
      expect(screen.getByTestId("brush-chart")).toBeInTheDocument();
    });

    const clearButton = screen.getByText("Clear");
    fireEvent.click(clearButton);

    expect(clearMock).toHaveBeenCalled();
  });

  it("calls reset method when Reset button is clicked", async () => {
    render(<Chart stockCode="CBA" />);

    await waitFor(() => {
      expect(screen.getByTestId("brush-chart")).toBeInTheDocument();
    });

    const resetButton = screen.getByText("Reset");
    fireEvent.click(resetButton);

    expect(resetMock).toHaveBeenCalled();
  });

  it("uses correct initial period", async () => {
    render(<Chart stockCode="CBA" />);

    await waitFor(() => {
      expect(mockFetchStockDataClient).toHaveBeenCalledWith("CBA", "5y");
    });
  });

  it("passes stock code to data fetch", async () => {
    render(<Chart stockCode="ZIP" />);

    await waitFor(() => {
      expect(mockFetchStockDataClient).toHaveBeenCalledWith("ZIP", "5y");
    });
  });

  it("handles empty data gracefully", async () => {
    mockFetchStockDataClient.mockResolvedValue({
      points: [],
      productCode: "CBA",
      max: null,
      min: null,
    } as any);

    render(<Chart stockCode="CBA" />);

    // Component uses fallback data when points are empty, so chart should still render
    await waitFor(() => {
      expect(screen.getByTestId("brush-chart")).toBeInTheDocument();
    });
  });

  it("updates when stock code changes", async () => {
    const { rerender } = render(<Chart stockCode="CBA" />);

    await waitFor(() => {
      expect(mockFetchStockDataClient).toHaveBeenCalledWith("CBA", "5y");
    });

    rerender(<Chart stockCode="ZIP" />);

    await waitFor(() => {
      expect(mockFetchStockDataClient).toHaveBeenCalledWith("ZIP", "5y");
    });
  });
});
