const auth = jest.fn();
const compareStrategies = jest.fn();
const createSignedInTransport = jest.fn();

jest.mock("~/server/auth", () => ({ auth: () => auth() }));
jest.mock("../../auth-transport", () => ({
  createSignedInTransport: (...args: unknown[]) => createSignedInTransport(...args),
}));
jest.mock("@connectrpc/connect", () => ({
  createClient: () => ({ compareStrategies: (...args: unknown[]) => compareStrategies(...args) }),
}));

import { compareStrategiesForViewer } from "../compare";

describe("compareStrategiesForViewer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    auth.mockResolvedValue({ user: { id: "u1" } });
    createSignedInTransport.mockResolvedValue({ transport: {} });
    compareStrategies.mockResolvedValue({
      windowId: "common",
      windowFrom: "2023-01-03",
      windowTo: "2026-11-06",
      entries: [{ strategyRef: "canslim", strategyId: "canslim", name: "CAN SLIM", state: "computed" }],
      correlations: [],
    });
  });

  it("refuses a list that is not two or three distinct strategy ids, without a session or a call", async () => {
    for (const refs of [[], ["a"], ["a", "a"], ["a", "b", "c", "d"], ["Bad Id", "b"], ["", "b"]]) {
      await expect(compareStrategiesForViewer(refs)).resolves.toEqual({ ok: false, reason: "invalid" });
    }
    expect(auth).not.toHaveBeenCalled();
    expect(compareStrategies).not.toHaveBeenCalled();
  });

  it("answers an anonymous caller signed-out, without a call", async () => {
    auth.mockResolvedValue(null);
    await expect(compareStrategiesForViewer(["canslim", "zanger-breakout"])).resolves.toEqual({
      ok: false,
      reason: "signed-out",
    });
    expect(compareStrategies).not.toHaveBeenCalled();
  });

  it("reads the comparison for a signed-in caller, sending identity only", async () => {
    const result = await compareStrategiesForViewer(["canslim", "zanger-breakout"]);
    expect(createSignedInTransport).toHaveBeenCalledWith({ withEmail: false });
    expect(compareStrategies).toHaveBeenCalledWith({ refs: ["canslim", "zanger-breakout"] });
    expect(result).toMatchObject({ ok: true, comparison: { windowId: "common", entries: [{ name: "CAN SLIM" }] } });
  });

  it("reports unavailable when the API call fails", async () => {
    compareStrategies.mockRejectedValue(new Error("boom"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(compareStrategiesForViewer(["canslim", "zanger-breakout"])).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    warn.mockRestore();
  });
});
