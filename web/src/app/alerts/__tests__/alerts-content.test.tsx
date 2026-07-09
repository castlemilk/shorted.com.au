import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import { AlertsWorkspace, industryLabelFromSlug } from "../alerts-content";

type MockCreateAlertInput = {
  scope: "industry" | "stock";
  target: string;
  condition:
    | "short-interest-above"
    | "short-interest-rises"
    | "new-top-ten-entry";
  threshold?: string;
  cadence: "Daily" | "Weekly";
};

const mockCreateAlertMonitor = jest.fn(async (input: MockCreateAlertInput) => ({
  ok: true,
  monitor: {
    id: "alert_1",
    scope: input.scope,
    target: input.target,
    condition: input.condition,
    threshold:
      input.condition === "new-top-ten-entry"
        ? null
        : Number.parseFloat(input.threshold ?? "0"),
    cadence: input.cadence,
    createdAt: "2026-07-08T00:00:00.000Z",
  },
}));

jest.mock("~/app/actions/alerts", () => ({
  createAlertMonitor: (input: MockCreateAlertInput) =>
    mockCreateAlertMonitor(input),
}));

describe("AlertsWorkspace", () => {
  beforeEach(() => {
    mockCreateAlertMonitor.mockClear();
  });

  it("uses the industry query value as the monitor target", async () => {
    render(<AlertsWorkspace initialIndustry="health-care-equipment" />);

    expect(screen.getByLabelText("Industry")).toHaveValue(
      "Health Care Equipment",
    );

    fireEvent.click(screen.getByRole("button", { name: /Save monitor/i }));

    expect(
      await screen.findByText("Industry monitor saved"),
    ).toBeInTheDocument();
    expect(mockCreateAlertMonitor).toHaveBeenCalledWith({
      scope: "industry",
      target: "Health Care Equipment",
      condition: "new-top-ten-entry",
      threshold: "5",
      cadence: "Daily",
    });
    expect(
      screen.getAllByText(/Health Care Equipment - new top-ten entry - daily/i),
    ).toHaveLength(2);
  });

  it("lets users configure a stock short-interest monitor", async () => {
    render(<AlertsWorkspace />);

    fireEvent.change(screen.getByLabelText("ASX code"), {
      target: { value: "bhp" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save monitor/i }));

    expect(await screen.findByText("Stock monitor saved")).toBeInTheDocument();
    expect(mockCreateAlertMonitor).toHaveBeenCalledWith({
      scope: "stock",
      target: "BHP",
      condition: "short-interest-above",
      threshold: "5",
      cadence: "Daily",
    });
    expect(
      screen.getAllByText(/BHP - short interest above 5% - daily/i),
    ).toHaveLength(2);
  });

  it("shows save errors returned by the API action", async () => {
    mockCreateAlertMonitor.mockResolvedValueOnce({
      ok: false,
      error: "Upgrade to Premium to save alerts.",
    });

    render(<AlertsWorkspace />);

    fireEvent.change(screen.getByLabelText("ASX code"), {
      target: { value: "bhp" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save monitor/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Upgrade to Premium to save alerts.",
    );
    expect(screen.queryByText("Stock monitor saved")).not.toBeInTheDocument();
  });
});

describe("industryLabelFromSlug", () => {
  it("formats slug values into labels", () => {
    expect(industryLabelFromSlug("consumer-discretionary")).toBe(
      "Consumer Discretionary",
    );
  });
});
