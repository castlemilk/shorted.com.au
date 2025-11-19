import React from "react";
import {
  act,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { TopShorts } from "../topShorts";
import { getTopShortsDataClient } from "../../actions/client/getTopShorts";

jest.mock("../../actions/client/getTopShorts", () => ({
  getTopShortsDataClient: jest.fn(),
}));

jest.mock("../components/sparkline", () => ({
  SparkLine: () => <div data-testid="sparkline"></div>,
}));

jest.mock("../components/data-table", () => ({
  DataTable: ({
    data,
    loading,
    isRefreshing,
    period,
  }: {
    data: Array<{ productCode: string; name: string }>;
    loading: boolean;
    isRefreshing?: boolean;
    period: string;
  }) => (
    <div>
      <div data-testid="period-label">{period}</div>
      <ul data-testid="rows">
        {data.map((row) => (
          <li key={row.productCode}>{row.productCode}</li>
        ))}
      </ul>
      {loading && <div data-testid="initial-loading">Loading…</div>}
      {isRefreshing && <div>Updating data…</div>}
    </div>
  ),
}));

jest.mock("~/@/components/ui/select", () => {
  const React = require("react");

  const Context = React.createContext<{
    onValueChange: (value: string) => void;
  }>({
    onValueChange: () => {},
  });

  const Select = ({
    onValueChange,
    children,
  }: {
    onValueChange: (value: string) => void;
    value?: string;
    children: React.ReactNode;
  }) => (
    <Context.Provider value={{ onValueChange }}>
      <div>{children}</div>
    </Context.Provider>
  );

  const SelectTrigger = ({
    children,
    ...props
  }: React.ComponentPropsWithoutRef<"button">) => (
    <button type="button" role="combobox" {...props}>
      {children}
    </button>
  );

  const SelectContent = ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  );

  const SelectValue = ({ placeholder }: { placeholder?: string }) => (
    <span>{placeholder}</span>
  );

  const SelectItem = ({
    value,
    children,
  }: {
    value: string;
    children: React.ReactNode;
  }) => {
    const { onValueChange } = React.useContext(Context);
    return (
      <button
        type="button"
        role="option"
        onClick={() => onValueChange(value)}
      >
        {children}
      </button>
    );
  };

  return {
    Select,
    SelectTrigger,
    SelectContent,
    SelectValue,
    SelectItem,
  };
});

jest.mock("../components/columns", () => ({
  columns: [
    {
      id: "productCode",
      accessorKey: "productCode",
      header: () => <span>Code</span>,
      cell: ({ row }: { row: { original: { productCode: string } } }) => (
        <span>{row.original.productCode}</span>
      ),
    },
  ],
}));

jest.mock("~/@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="card">{children}</div>
  ),
  CardTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
}));

jest.mock("~/@/components/ui/label", () => ({
  Label: ({
    children,
    ...props
  }: React.ComponentPropsWithoutRef<"label">) => (
    <label {...props}>{children}</label>
  ),
}));

jest.mock("~/@/components/ui/skeleton", () => ({
  Skeleton: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="skeleton">{children}</div>
  ),
}));

const mockGetTopShortsDataClient = jest.mocked(getTopShortsDataClient);

const createDeferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

describe("TopShorts", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("keeps existing rows visible while refreshing period data", async () => {
    const initialData = [
      {
        productCode: "AAA",
        name: "Example Corp",
        latestShortPosition: 10,
        points: [],
      },
    ];

    render(
      <TopShorts
        initialShortsData={initialData as any}
        initialPeriod="3m"
      />,
    );

    expect(screen.getByText("AAA")).toBeInTheDocument();

    const deferred = createDeferred<any>();
    mockGetTopShortsDataClient.mockReturnValueOnce(deferred.promise);

    const user = userEvent.setup();
    const trigger = screen.getByRole("combobox");
    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: /6 months/i }));

    expect(mockGetTopShortsDataClient).toHaveBeenCalledWith(
      "6m",
      10,
      0,
    );

    expect(
      screen.getByText("Updating data…"),
    ).toBeInTheDocument();
    // Verify the existing data remains visible during refresh
    expect(screen.getByText("AAA")).toBeInTheDocument();

    await act(async () => {
      deferred.resolve({
        timeSeries: [
          {
            productCode: "BBB",
            name: "Updated Corp",
            latestShortPosition: 5,
            points: [],
          },
        ],
      });
    });

    await waitFor(() =>
      expect(
        screen.queryByText("Updating data…"),
      ).not.toBeInTheDocument(),
    );

    expect(screen.queryByText("AAA")).not.toBeInTheDocument();
    expect(screen.getByText("BBB")).toBeInTheDocument();
  });
});

