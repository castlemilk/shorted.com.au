import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { useSession } from "next-auth/react";

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
  emailDeliverable: true,
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

// The monitor and event lists are other components on the page; the builder
// test only needs them not to fetch.
// The verification prompt's server action is not under test here.
jest.mock("~/app/actions/email-verification", () => ({
  sendAlertVerificationEmail: jest.fn(),
}));

jest.mock("../alert-monitor-list", () => ({
  AlertMonitorList: () => null,
  AlertDeliveryNote: () => null,
}));
jest.mock("../alert-events-list", () => ({
  AlertEventsList: () => null,
}));

function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

/**
 * The trigger is the select that offers the short-interest-above option. Found
 * by its options: an industry input with a datalist also has the combobox role,
 * so an index into the combobox list is not stable.
 */
function triggerSelect(): HTMLSelectElement {
  const trigger = Array.from(document.querySelectorAll("select")).find(
    (select) => select.querySelector('option[value="short-interest-above"]'),
  );
  if (!trigger) throw new Error("trigger select not rendered");
  return trigger;
}

describe("AlertsWorkspace", () => {
  beforeEach(() => {
    mockCreateAlertMonitor.mockClear();
    // A verified account, so the builder's existing tests see no verification prompt.
    (useSession as unknown as jest.Mock).mockReturnValue({
      data: {
        user: { id: "u1", email: "trader@example.com", emailVerified: true },
      },
      status: "authenticated",
      update: jest.fn().mockResolvedValue({ user: { emailVerified: true } }),
    });
  });

  it("uses the industry query value as the monitor target", async () => {
    renderWithQuery(
      <AlertsWorkspace initialIndustry="health-care-equipment" />,
    );

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
    renderWithQuery(<AlertsWorkspace />);

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

    renderWithQuery(<AlertsWorkspace />);

    fireEvent.change(screen.getByLabelText("ASX code"), {
      target: { value: "bhp" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save monitor/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Upgrade to Premium to save alerts.",
    );
    expect(screen.queryByText("Stock monitor saved")).not.toBeInTheDocument();
  });

  it("offers the industry names as a datalist for industry monitors", () => {
    const { container } = renderWithQuery(
      <AlertsWorkspace
        initialIndustry="materials"
        industryNames={["Materials", "Banks"]}
      />,
    );

    const input = screen.getByLabelText("Industry");
    const listId = input.getAttribute("list");
    expect(listId).toBeTruthy();

    const datalist = container.querySelector(`datalist#${listId}`);
    expect(datalist).not.toBeNull();
    const options = Array.from(datalist?.querySelectorAll("option") ?? []).map(
      (option) => option.getAttribute("value"),
    );
    expect(options).toEqual(["Materials", "Banks"]);
  });

  it("explains that an industry trigger checks every company in it", () => {
    renderWithQuery(<AlertsWorkspace initialIndustry="materials" />);

    fireEvent.change(triggerSelect(), {
      target: { value: "short-interest-above" },
    });

    expect(
      screen.getByText(
        "Notify when any company in this industry crosses the threshold.",
      ),
    ).toBeInTheDocument();
  });

  it("uses the stock wording for a stock monitor", () => {
    renderWithQuery(<AlertsWorkspace />);

    expect(
      screen.getByText(
        "Notify when reported short interest crosses the threshold.",
      ),
    ).toBeInTheDocument();
  });

  it("labels a rises threshold in points and an above threshold in percent", () => {
    renderWithQuery(<AlertsWorkspace />);

    expect(screen.getByText("%", { selector: "span" })).toBeInTheDocument();

    fireEvent.change(triggerSelect(), {
      target: { value: "short-interest-rises" },
    });

    expect(screen.getByText("pts", { selector: "span" })).toBeInTheDocument();
    expect(
      screen.queryByText("%", { selector: "span" }),
    ).not.toBeInTheDocument();
  });

  it("shows the crossing note for above triggers only", () => {
    renderWithQuery(<AlertsWorkspace />);

    const note =
      "Crossing alerts fire on the next crossing, not the current level.";
    expect(screen.getByText(note)).toBeInTheDocument();

    fireEvent.change(triggerSelect(), {
      target: { value: "short-interest-rises" },
    });
    expect(screen.queryByText(note)).not.toBeInTheDocument();
  });

  it("describes the two cadences", () => {
    renderWithQuery(<AlertsWorkspace />);

    expect(
      screen.getByText(
        /Daily: after each new ASIC report\. Weekly: once a week/,
      ),
    ).toBeInTheDocument();
  });

  it("names the rises unit in the saved summary", async () => {
    renderWithQuery(<AlertsWorkspace />);

    fireEvent.change(screen.getByLabelText("ASX code"), {
      target: { value: "bhp" },
    });
    fireEvent.change(triggerSelect(), {
      target: { value: "short-interest-rises" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save monitor/i }));

    const saved = await screen.findByText("Stock monitor saved");
    const card = saved.parentElement as HTMLElement;
    expect(
      within(card).getByText("BHP - short interest rises by 5 pts - daily"),
    ).toBeInTheDocument();
  });
});

describe("industryLabelFromSlug", () => {
  it("formats slug values into labels", () => {
    expect(industryLabelFromSlug("consumer-discretionary")).toBe(
      "Consumer Discretionary",
    );
  });
});

const VERIFIED = {
  data: {
    user: { id: "u1", email: "trader@example.com", emailVerified: true },
  },
  status: "authenticated",
  update: jest.fn().mockResolvedValue({ user: { emailVerified: true } }),
};
const UNVERIFIED_SESSION = {
  data: {
    user: { id: "u1", email: "trader@example.com", emailVerified: false },
  },
  status: "authenticated",
  update: jest.fn().mockResolvedValue({ user: { emailVerified: false } }),
};

describe("AlertsWorkspace verification feedback", () => {
  beforeEach(() => {
    mockCreateAlertMonitor.mockClear();
    (useSession as unknown as jest.Mock).mockReturnValue(VERIFIED);
  });

  it("shows an inline warning beside save when the address is unverified, and keeps save enabled", async () => {
    (useSession as unknown as jest.Mock).mockReturnValue(UNVERIFIED_SESSION);
    renderWithQuery(<AlertsWorkspace />);

    const note = screen.getByRole("note");
    expect(note).toHaveTextContent(
      "Alerts are saved but not emailed until you verify trader@example.com.",
    );
    // The prompt is loaded client-only, so its send action appears after a tick.
    expect(
      await within(note).findByRole("button", {
        name: "Send verification email",
      }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("ASX code"), {
      target: { value: "bhp" },
    });
    expect(screen.getByRole("button", { name: /Save monitor/i })).toBeEnabled();
  });

  it("shows no warning when the address is verified", () => {
    renderWithQuery(<AlertsWorkspace />);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("says after a save that the alert is not emailed until the address is verified", async () => {
    (useSession as unknown as jest.Mock).mockReturnValue(UNVERIFIED_SESSION);
    mockCreateAlertMonitor.mockResolvedValueOnce({
      ok: true,
      emailDeliverable: false,
      monitor: {
        id: "alert_2",
        scope: "stock",
        target: "BHP",
        condition: "short-interest-above",
        threshold: 5,
        cadence: "Daily",
        createdAt: null,
      },
    } as never);
    renderWithQuery(<AlertsWorkspace />);

    fireEvent.change(screen.getByLabelText("ASX code"), {
      target: { value: "bhp" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save monitor/i }));

    expect(
      await screen.findByText(/Saved\. It is not emailed until you verify/),
    ).toHaveTextContent(
      "Saved. It is not emailed until you verify trader@example.com.",
    );
  });

  it("gives no after-save warning when the saved alert will be emailed", async () => {
    renderWithQuery(<AlertsWorkspace />);

    fireEvent.change(screen.getByLabelText("ASX code"), {
      target: { value: "bhp" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save monitor/i }));

    expect(await screen.findByText("Stock monitor saved")).toBeInTheDocument();
    expect(screen.queryByText(/not emailed until you verify/)).toBeNull();
  });
});
