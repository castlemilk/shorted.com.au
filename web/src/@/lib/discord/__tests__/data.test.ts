/**
 * @jest-environment node
 */
// The bot's newest-close read: the chart data's read, bounded so a slow one
// answers null (the chart is then posted live) instead of holding Discord.

const mockClose = jest.fn();

jest.mock("~/app/actions/getLatestShortDate", () => ({
  getLatestShortDate: jest.fn(),
}));
jest.mock("~/app/actions/getStock", () => ({ getStock: jest.fn() }));
jest.mock("~/app/actions/getTopShorts", () => ({
  getTopShortsSummary: jest.fn(),
}));
jest.mock("~/app/actions/searchStocks", () => ({ searchStocks: jest.fn() }));
jest.mock("~/app/shorts/[stockCode]/short-interest-summary", () => ({
  getShortInterestDeltas: jest.fn(),
}));
jest.mock("~/app/chart/[code]/image/chart-data", () => ({
  ...jest.requireActual("~/app/chart/[code]/image/chart-data"),
  getNewestClose: (...args: unknown[]) => mockClose(...args) as unknown,
}));

import { discordData } from "../data";

describe("discordData.newestClose", () => {
  beforeEach(() => {
    mockClose.mockReset();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("answers the close the chart data reads for the day", async () => {
    mockClose.mockResolvedValue("2026-10-16");
    await expect(discordData.newestClose("BHP", "2026-10-19")).resolves.toBe(
      "2026-10-16",
    );
    expect(mockClose).toHaveBeenCalledWith("BHP", "2026-10-19");
  });

  it("answers null when there is no close", async () => {
    mockClose.mockResolvedValue(null);
    await expect(
      discordData.newestClose("BHP", "2026-10-19"),
    ).resolves.toBeNull();
  });

  it("answers null when the read is too slow, rather than holding the reply", async () => {
    jest.useFakeTimers();
    mockClose.mockReturnValue(new Promise(() => undefined));
    const answer = discordData.newestClose("BHP", "2026-10-19");
    jest.advanceTimersByTime(6000);
    await expect(answer).resolves.toBeNull();
  });
});
