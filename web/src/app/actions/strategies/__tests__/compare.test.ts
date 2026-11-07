const auth = jest.fn();
const compareStrategies = jest.fn();
const listStrategyEvidence = jest.fn();
const createSignedInTransport = jest.fn();

jest.mock("~/server/auth", () => ({ auth: () => auth() }));
jest.mock("../../auth-transport", () => ({
  createSignedInTransport: (...args: unknown[]) => createSignedInTransport(...args),
}));
jest.mock("@connectrpc/connect", () => ({
  createClient: () => ({
    compareStrategies: (...args: unknown[]) => compareStrategies(...args),
    listStrategyEvidence: (...args: unknown[]) => listStrategyEvidence(...args),
  }),
}));

import * as fs from "fs";
import * as path from "path";
import { compareStrategiesForViewer } from "../compare";

const COMPARE_ROW = {
  windowId: "common",
  windowFrom: "2023-01-03",
  windowTo: "2026-11-06",
  entries: [{ strategyRef: "canslim", strategyId: "canslim", name: "CAN SLIM", state: "published" }],
  correlations: [],
  ruleDiffs: [],
};

describe("compareStrategiesForViewer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    auth.mockResolvedValue({ user: { id: "u1" } });
    createSignedInTransport.mockResolvedValue({ transport: {} });
    compareStrategies.mockResolvedValue(COMPARE_ROW);
    listStrategyEvidence.mockResolvedValue({
      strategies: [{ strategyId: "canslim", survivorship: "Flatters results." }, { strategyId: "zanger-breakout", survivorship: "" }],
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
    await expect(compareStrategiesForViewer(["canslim", "zanger-breakout"])).resolves.toEqual({ ok: false, reason: "signed-out" });
    expect(compareStrategies).not.toHaveBeenCalled();
  });

  it("reads the comparison and each strategy's survivorship for a signed-in caller, sending identity only", async () => {
    const result = await compareStrategiesForViewer(["canslim", "zanger-breakout"]);
    expect(createSignedInTransport).toHaveBeenCalledWith({ withEmail: false });
    expect(compareStrategies).toHaveBeenCalledWith({ refs: ["canslim", "zanger-breakout"] });
    expect(result).toMatchObject({
      ok: true,
      comparison: { windowId: "common", entries: [{ name: "CAN SLIM" }] },
      survivorship: { canslim: "Flatters results.", "zanger-breakout": "" },
    });
  });

  it("catches an auth() failure inside the try and answers unavailable, never a rejection", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    auth.mockRejectedValue(new Error("session store down"));
    await expect(compareStrategiesForViewer(["canslim", "zanger-breakout"])).resolves.toEqual({ ok: false, reason: "unavailable" });
    warn.mockRestore();
  });

  it("names a permanent failure as its own reason: not-found, and invalid, and a refused session", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    compareStrategies.mockRejectedValueOnce({ code: 5, message: "no such strategy" });
    await expect(compareStrategiesForViewer(["canslim", "zanger-breakout"])).resolves.toEqual({ ok: false, reason: "not-found" });
    compareStrategies.mockRejectedValueOnce({ code: 3, message: "bad" });
    await expect(compareStrategiesForViewer(["canslim", "zanger-breakout"])).resolves.toEqual({ ok: false, reason: "invalid" });
    compareStrategies.mockRejectedValueOnce({ code: 16, message: "no session" });
    await expect(compareStrategiesForViewer(["canslim", "zanger-breakout"])).resolves.toEqual({ ok: false, reason: "signed-out" });
    warn.mockRestore();
  });

  it("reports a transient failure as unavailable, so the page can offer a retry", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    compareStrategies.mockRejectedValue(new Error("boom"));
    await expect(compareStrategiesForViewer(["canslim", "zanger-breakout"])).resolves.toEqual({ ok: false, reason: "unavailable" });
    warn.mockRestore();
  });
});

describe("compare.ts imports no cache helper (per-viewer reads are never shared)", () => {
  it("imports neither unstable_cache, a KV helper nor the evidence cache module", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "compare.ts"), "utf8");
    expect(source).not.toMatch(/unstable_cache|next\/cache|kv|Redis|upstash|getStrategyEvidence/i);
  });
});
