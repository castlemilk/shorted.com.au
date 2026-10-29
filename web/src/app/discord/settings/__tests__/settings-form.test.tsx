import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockSave = jest.fn();
const mockSearch = jest.fn();
const mockPreview = jest.fn();

jest.mock("../actions", () => ({
  saveDiscordSettings: (...args: unknown[]) => mockSave(...args) as unknown,
  searchDiscordStocks: (...args: unknown[]) => mockSearch(...args) as unknown,
  previewStock: (...args: unknown[]) => mockPreview(...args) as unknown,
}));

import { ASK_FOR_STOCK } from "~/@/lib/discord/messages";
import {
  BUILT_IN_SETTINGS,
  type DiscordSettings,
} from "~/@/lib/discord/settings";
import { DiscordSettingsForm } from "../settings-form";

const soon = () => Math.floor(Date.now() / 1000) + 25 * 60;

function renderForm(
  initial: Partial<DiscordSettings> = {},
  options: { activityEnabled?: boolean; initialName?: string } = {},
) {
  return render(
    <DiscordSettingsForm
      scope="guild"
      initial={{ ...BUILT_IN_SETTINGS, ...initial }}
      initialName={options.initialName}
      expiresAt={soon()}
      activityEnabled={options.activityEnabled ?? true}
    />,
  );
}

const chartCard = () =>
  screen.getByRole("img", { name: /chart card the bot posts/i });

describe("DiscordSettingsForm", () => {
  beforeEach(() => {
    mockSave.mockReset();
    mockSearch.mockReset().mockResolvedValue([]);
    mockPreview.mockReset().mockResolvedValue(null);
  });

  it("previews the chart message these settings post", async () => {
    renderForm(
      { code: "PLS", view: "combined", period: "6m" },
      {
        initialName: "Pilbara Minerals",
      },
    );
    const preview = screen.getByRole("complementary", { name: "Preview" });
    expect(
      within(preview).getByText("PLS · Pilbara Minerals"),
    ).toBeInTheDocument();
    expect(chartCard().getAttribute("src")).toMatch(
      /^\/chart\/PLS\/image\?view=combined&period=6m&v=\d{4}-\d{2}-\d{2}$/,
    );
    // The buttons a chart message carries, the active ones as Discord's primary.
    expect(within(preview).getByText("Interactive")).toBeInTheDocument();
    expect(within(preview).getByText("Open on Shorted")).toBeInTheDocument();
    await waitFor(() => expect(mockPreview).toHaveBeenCalledWith("PLS"));
  });

  it("shows the readings once they arrive", async () => {
    mockPreview.mockResolvedValue({
      code: "PLS",
      name: "Pilbara Minerals",
      shortPct: 12.345,
      change30d: 0.62,
      asOf: "2026-10-20T00:00:00.000Z",
    });
    renderForm({ code: "PLS" });
    expect(
      await screen.findByText("12.35%", { exact: false }),
    ).toBeInTheDocument();
  });

  it("redraws the preview when a setting changes", async () => {
    const user = userEvent.setup();
    renderForm({ code: "PLS" });
    await user.click(screen.getByRole("radio", { name: /^Price/ }));
    await user.click(screen.getByRole("radio", { name: "3 months" }));
    expect(chartCard().getAttribute("src")).toMatch(/view=price&period=3m/);
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");
  });

  it("previews the question a command asks with no default stock, then BHP", () => {
    renderForm({ code: null });
    expect(screen.getByText("Only you can see this")).toBeInTheDocument();
    expect(
      screen.getByText(/Which stock\? Give me an ASX code/),
    ).toBeInTheDocument();
    expect(ASK_FOR_STOCK).toMatch(/^Which stock\?/);
    expect(screen.getByText("/chart BHP")).toBeInTheDocument();
    expect(chartCard().getAttribute("src")).toMatch(/^\/chart\/BHP\/image/);
  });

  it("previews the interactive chart in interactive mode", async () => {
    const user = userEvent.setup();
    renderForm({ code: "PLS", view: "price", period: "1m" });
    await user.click(screen.getByRole("radio", { name: /interactive chart/i }));
    const frame = screen.getByTitle(/interactive chart/i);
    expect(frame.getAttribute("src")).toBe(
      "/embed/discord?code=PLS&view=price&period=1m",
    );
  });

  it("offers no interactive mode when the Activity is off", () => {
    renderForm({ code: "PLS" }, { activityEnabled: false });
    expect(
      screen.getByRole("radio", { name: /interactive chart/i }),
    ).toBeDisabled();
    expect(screen.queryByText("Interactive")).not.toBeInTheDocument();
  });

  it("picks a default stock from the search", async () => {
    const user = userEvent.setup();
    mockSearch.mockResolvedValue([
      { code: "PLS", name: "Pilbara Minerals", shortPct: 12.3 },
      { code: "PLL", name: "Piedmont Lithium" },
    ]);
    renderForm({ code: null });
    const input = screen.getByRole("combobox");
    await user.type(input, "pil");
    const option = await screen.findByRole("option", { name: /Piedmont/ });
    expect(mockSearch).toHaveBeenLastCalledWith("pil");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(option).not.toBeInTheDocument();
    expect(screen.getByText("PLL")).toBeInTheDocument();
    expect(chartCard().getAttribute("src")).toMatch(/^\/chart\/PLL\/image/);
  });

  it("removes the default stock", async () => {
    const user = userEvent.setup();
    renderForm({ code: "PLS" });
    await user.click(
      screen.getByRole("button", { name: "Remove PLS as the default stock" }),
    );
    expect(
      screen.getByText(/A command without a code asks/),
    ).toBeInTheDocument();
  });

  it("saves, then shows the saved state", async () => {
    const user = userEvent.setup();
    const saved = {
      ...BUILT_IN_SETTINGS,
      code: "PLS",
      period: "max" as const,
    };
    mockSave.mockResolvedValue({ ok: true, settings: saved });
    renderForm({ code: "PLS" });
    const save = screen.getByRole("button", { name: "Save settings" });
    expect(save).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "All history" }));
    await user.click(save);
    expect(mockSave).toHaveBeenCalledWith(saved);
    expect(await screen.findByText(/^Saved\./)).toBeInTheDocument();
    expect(save).toBeDisabled();
  });

  it("stops saving once the link has expired", async () => {
    const user = userEvent.setup();
    mockSave.mockResolvedValue({
      ok: false,
      expired: true,
      error: "This link has expired. Run /settings in Discord for a new one.",
    });
    renderForm({ code: "PLS" });
    await user.click(screen.getByRole("radio", { name: "1 month" }));
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(
      await screen.findByText(/This link has expired/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save settings" }),
    ).toBeDisabled();
  });

  it("puts the defaults back with one button", async () => {
    const user = userEvent.setup();
    renderForm({ code: "PLS", view: "price", interactive: true });
    await user.click(screen.getByRole("button", { name: "Use the defaults" }));
    expect(
      screen.getByRole("radio", { name: /^Short interest/ }),
    ).toBeChecked();
    expect(screen.getByRole("radio", { name: /chart message/i })).toBeChecked();
    expect(
      screen.getByText(/A command without a code asks/),
    ).toBeInTheDocument();
  });
});
