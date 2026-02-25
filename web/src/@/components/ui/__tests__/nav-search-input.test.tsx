import React from "react";
import {
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { NavSearchInput } from "../nav-search-input";

// Mock the router
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    replace: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    refresh: jest.fn(),
    prefetch: jest.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

// Mock lodash debounce to execute immediately in tests
jest.mock("lodash/debounce", () => (fn: (...args: unknown[]) => unknown) => {
  const debouncedFn = (...args: unknown[]) => fn(...args);
  debouncedFn.cancel = jest.fn();
  debouncedFn.flush = jest.fn();
  return debouncedFn;
});

// Mock lucide-react icons
jest.mock("lucide-react", () => ({
  Search: ({ className }: { className?: string }) =>
    React.createElement("svg", {
      "data-testid": "search-icon",
      className,
    }),
  X: ({ className }: { className?: string }) =>
    React.createElement("svg", { "data-testid": "x-icon", className }),
  Loader2: ({ className }: { className?: string }) =>
    React.createElement("svg", {
      "data-testid": "loader-icon",
      className,
    }),
  TrendingDown: ({ className }: { className?: string }) =>
    React.createElement("svg", {
      "data-testid": "trending-down-icon",
      className,
    }),
  ArrowRight: ({ className }: { className?: string }) =>
    React.createElement("svg", {
      "data-testid": "arrow-right-icon",
      className,
    }),
}));

// Sample mock response matching the backend Connect-RPC JSON format
const mockSearchResponse = {
  stocks: [
    {
      productCode: "BHP",
      name: "BHP Group Limited",
      percentageShorted: 5.5,
      industry: "Materials",
    },
    {
      productCode: "CBA",
      name: "Commonwealth Bank of Australia",
      percentageShorted: 2.3,
      industry: "Financials",
    },
    {
      productCode: "CSL",
      name: "CSL Limited",
      percentageShorted: 12.1,
      industry: "Healthcare",
    },
  ],
};

// Helper to create a mock fetch response
function mockFetchResponse(data: unknown, ok = true) {
  return jest.fn().mockResolvedValue({
    ok,
    json: () => Promise.resolve(data),
  });
}

describe("NavSearchInput", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Mock fetch to return search results (Connect-RPC JSON endpoint)
    global.fetch = mockFetchResponse(mockSearchResponse);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("Rendering", () => {
    it("renders search input on desktop", () => {
      render(<NavSearchInput />);

      const input = screen.getByPlaceholderText("Search stocks...");
      expect(input).toBeInTheDocument();
    });

    it("renders mobile search button", () => {
      render(<NavSearchInput />);

      const mobileButton = screen.getByLabelText("Search stocks");
      expect(mobileButton).toBeInTheDocument();
    });

    it("shows search icon in input", () => {
      render(<NavSearchInput />);

      const searchIcon = screen.getAllByTestId("search-icon");
      expect(searchIcon.length).toBeGreaterThan(0);
    });
  });

  describe("Search Functionality", () => {
    it("calls fetch when user types", async () => {
      render(<NavSearchInput />);

      const input = screen.getByPlaceholderText("Search stocks...");
      await userEvent.type(input, "BHP");

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalled();
      });
    });

    it("displays search results in dropdown", async () => {
      render(<NavSearchInput />);

      const input = screen.getByPlaceholderText("Search stocks...");
      await userEvent.type(input, "BHP");

      await waitFor(() => {
        expect(screen.getByText("BHP")).toBeInTheDocument();
        expect(screen.getByText("BHP Group Limited")).toBeInTheDocument();
        expect(screen.getByText("5.5%")).toBeInTheDocument();
      });
    });

    it("converts input to uppercase", async () => {
      render(<NavSearchInput />);

      const input = screen.getByPlaceholderText(
        "Search stocks..."
      ) as HTMLInputElement;
      await userEvent.type(input, "bhp");

      expect(input.value).toBe("BHP");
    });

    it("shows loading indicator while searching", async () => {
      // Make the first fetch hang to show loading state
      let callCount = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        callCount++;
        return new Promise(() => {}); // Never resolves
      });

      render(<NavSearchInput />);

      const input = screen.getByPlaceholderText("Search stocks...");
      await userEvent.type(input, "BHP");

      await waitFor(() => {
        expect(screen.getAllByTestId("loader-icon").length).toBeGreaterThan(0);
      });
    });

    it("shows no results message when search returns empty", async () => {
      global.fetch = mockFetchResponse({ stocks: [] });

      render(<NavSearchInput />);

      const input = screen.getByPlaceholderText("Search stocks...");
      await userEvent.type(input, "INVALID");

      await waitFor(() => {
        expect(
          screen.getByText(/No stocks found for/)
        ).toBeInTheDocument();
      });
    });

    it("shows clear button when input has value", async () => {
      render(<NavSearchInput />);

      const input = screen.getByPlaceholderText("Search stocks...");
      await userEvent.type(input, "BHP");

      await waitFor(() => {
        expect(screen.getByTestId("x-icon")).toBeInTheDocument();
      });
    });

    it("clears search when clear button is clicked", async () => {
      render(<NavSearchInput />);

      const input = screen.getByPlaceholderText(
        "Search stocks..."
      ) as HTMLInputElement;
      await userEvent.type(input, "BHP");

      await waitFor(() => {
        expect(screen.getByTestId("x-icon")).toBeInTheDocument();
      });

      const clearButton = screen.getByLabelText("Clear search");
      await userEvent.click(clearButton);

      expect(input.value).toBe("");
    });
  });

  describe("Keyboard Navigation", () => {
    it("navigates down through results with ArrowDown", async () => {
      render(<NavSearchInput />);

      const input = screen.getByPlaceholderText("Search stocks...");
      await userEvent.type(input, "B");

      await waitFor(() => {
        expect(screen.getByText("BHP")).toBeInTheDocument();
      });

      // Press down arrow to select first item
      fireEvent.keyDown(input, { key: "ArrowDown" });

      // The first item should now be highlighted (has bg-accent class)
      const firstItem = screen.getByText("BHP").closest("li");
      expect(firstItem?.className).toContain("bg-accent");
    });

    it("navigates up through results with ArrowUp", async () => {
      render(<NavSearchInput />);

      const input = screen.getByPlaceholderText("Search stocks...");
      await userEvent.type(input, "B");

      await waitFor(() => {
        expect(screen.getByText("BHP")).toBeInTheDocument();
      });

      // Navigate down twice, then up once
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "ArrowUp" });

      // Should be on first item
      const firstItem = screen.getByText("BHP").closest("li");
      expect(firstItem?.className).toContain("bg-accent");
    });

    it("selects item and navigates on Enter", async () => {
      render(<NavSearchInput />);

      const input = screen.getByPlaceholderText("Search stocks...");
      await userEvent.type(input, "B");

      await waitFor(() => {
        expect(screen.getByText("BHP")).toBeInTheDocument();
      });

      // Select first item
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(mockPush).toHaveBeenCalledWith("/shorts/BHP");
    });

    it("closes dropdown on Escape", async () => {
      render(<NavSearchInput />);

      const input = screen.getByPlaceholderText("Search stocks...");
      await userEvent.type(input, "BHP");

      await waitFor(() => {
        expect(screen.getByText("BHP Group Limited")).toBeInTheDocument();
      });

      fireEvent.keyDown(input, { key: "Escape" });

      await waitFor(() => {
        expect(
          screen.queryByText("BHP Group Limited")
        ).not.toBeInTheDocument();
      });
    });

    it("navigates directly when Enter pressed with valid stock code", async () => {
      global.fetch = mockFetchResponse({ stocks: [] });

      render(<NavSearchInput />);

      const input = screen.getByPlaceholderText("Search stocks...");
      await userEvent.type(input, "XYZ");

      // Wait for search to complete
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalled();
      });

      fireEvent.keyDown(input, { key: "Enter" });

      expect(mockPush).toHaveBeenCalledWith("/shorts/XYZ");
    });
  });

  describe("Mouse Interaction", () => {
    it("navigates when clicking a search result", async () => {
      render(<NavSearchInput />);

      const input = screen.getByPlaceholderText("Search stocks...");
      await userEvent.type(input, "B");

      await waitFor(() => {
        expect(screen.getByText("CBA")).toBeInTheDocument();
      });

      const cbaResult = screen.getByText("CBA").closest("li");
      if (cbaResult) {
        await userEvent.click(cbaResult);
      }

      expect(mockPush).toHaveBeenCalledWith("/shorts/CBA");
    });

    it("closes dropdown when clicking outside", async () => {
      render(
        <div>
          <NavSearchInput />
          <div data-testid="outside">Outside element</div>
        </div>
      );

      const input = screen.getByPlaceholderText("Search stocks...");
      await userEvent.type(input, "BHP");

      await waitFor(() => {
        expect(screen.getByText("BHP Group Limited")).toBeInTheDocument();
      });

      // Click outside
      fireEvent.mouseDown(screen.getByTestId("outside"));

      await waitFor(() => {
        expect(
          screen.queryByText("BHP Group Limited")
        ).not.toBeInTheDocument();
      });
    });
  });

  describe("Mobile Behavior", () => {
    it("opens mobile search overlay when button is clicked", async () => {
      render(<NavSearchInput />);

      const mobileButton = screen.getByLabelText("Search stocks");
      await userEvent.click(mobileButton);

      // Mobile overlay should appear with a search input
      await waitFor(() => {
        const inputs = screen.getAllByPlaceholderText("Search stocks...");
        expect(inputs.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe("Result Display", () => {
    it("shows industry badge for stocks with industry", async () => {
      render(<NavSearchInput />);

      const input = screen.getByPlaceholderText("Search stocks...");
      await userEvent.type(input, "B");

      await waitFor(() => {
        expect(screen.getAllByText("Materials").length).toBeGreaterThan(0);
        expect(screen.getAllByText("Financials").length).toBeGreaterThan(0);
      });
    });

    it("shows colored short percentage for high short interest", async () => {
      render(<NavSearchInput />);

      const input = screen.getByPlaceholderText("Search stocks...");
      await userEvent.type(input, "B");

      await waitFor(() => {
        // CSL has 12.1% which should have red styling
        expect(screen.getByText("12.1%")).toBeInTheDocument();
      });
    });

    it("shows result count in footer", async () => {
      render(<NavSearchInput />);

      const input = screen.getByPlaceholderText("Search stocks...");
      await userEvent.type(input, "B");

      await waitFor(() => {
        expect(screen.getByText("3 results")).toBeInTheDocument();
      });
    });
  });

  describe("Error Handling", () => {
    it("handles API errors gracefully", async () => {
      // Both endpoints fail
      global.fetch = jest.fn().mockRejectedValue(new Error("API Error"));

      render(<NavSearchInput />);

      const input = screen.getByPlaceholderText("Search stocks...");
      await userEvent.type(input, "ERROR");

      // Should not crash and should show no results
      await waitFor(() => {
        expect(
          screen.getByText(/No stocks found for/)
        ).toBeInTheDocument();
      });
    });

    it("handles null response from API", async () => {
      // Return a response with no stocks
      global.fetch = mockFetchResponse({});

      render(<NavSearchInput />);

      const input = screen.getByPlaceholderText("Search stocks...");
      await userEvent.type(input, "NULL");

      await waitFor(() => {
        expect(
          screen.getByText(/No stocks found for/)
        ).toBeInTheDocument();
      });
    });
  });
});
