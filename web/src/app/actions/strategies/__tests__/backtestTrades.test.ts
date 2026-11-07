import { readFileSync } from "node:fs";
import { join } from "node:path";

import { listBacktestTrades } from "../backtestTrades";

const auth = jest.fn();
const createSignedInTransport = jest.fn();
const listCall = jest.fn();

jest.mock("~/server/auth", () => ({
  auth: () => auth(),
}));
jest.mock("../../auth-transport", () => ({
  createSignedInTransport: (...args: unknown[]) => createSignedInTransport(...args),
}));
jest.mock("@connectrpc/connect", () => ({
  createClient: () => ({
    listBacktestTrades: (...args: unknown[]) => listCall(...args),
  }),
}));

describe("listBacktestTrades (the signed-in trade list)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createSignedInTransport.mockResolvedValue({ transport: {} });
    listCall.mockResolvedValue({ trades: [], nextPageToken: "", total: 0 });
  });

  it("answers signed-out without any call to the API", async () => {
    auth.mockResolvedValue(null);
    await expect(listBacktestTrades({ runId: 42 })).resolves.toEqual({ ok: false, reason: "signed-out" });
    expect(createSignedInTransport).not.toHaveBeenCalled();
    expect(listCall).not.toHaveBeenCalled();
  });

  it("refuses a run id that is not a positive integer, before any session is read", async () => {
    await expect(listBacktestTrades({ runId: 0 })).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(listBacktestTrades({ runId: 1.5 })).resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(auth).not.toHaveBeenCalled();
  });

  it("sends identity only, never an address or a verification flag", async () => {
    auth.mockResolvedValue({ user: { id: "u1" } });
    await listBacktestTrades({ runId: 42 });
    expect(createSignedInTransport).toHaveBeenCalledWith({ withEmail: false });
  });

  it("sends the run and the default page of fifty", async () => {
    auth.mockResolvedValue({ user: { id: "u1" } });
    await listBacktestTrades({ runId: 42 });
    expect(listCall).toHaveBeenCalledWith({
      runId: BigInt(42),
      pageToken: "",
      pageSize: 50,
      stockCode: "",
      exitReason: "",
    });
  });

  it("clamps the page size to 200, and normalises a valid stock code", async () => {
    auth.mockResolvedValue({ user: { id: "u1" } });
    await listBacktestTrades({ runId: 42, pageSize: 9999, stockCode: "bhp", exitReason: "pivot_stop" });
    expect(listCall).toHaveBeenLastCalledWith(
      expect.objectContaining({ pageSize: 200, stockCode: "BHP", exitReason: "pivot_stop" }),
    );
  });

  it("reports an invalid filter or page token, and sends nothing", async () => {
    auth.mockResolvedValue({ user: { id: "u1" } });
    await expect(listBacktestTrades({ runId: 42, stockCode: "BH P!" })).resolves.toEqual({ ok: false, reason: "invalid", error: "stock" });
    await expect(listBacktestTrades({ runId: 42, exitReason: "x y" })).resolves.toEqual({ ok: false, reason: "invalid", error: "reason" });
    await expect(listBacktestTrades({ runId: 42, pageToken: "a b" })).resolves.toEqual({ ok: false, reason: "invalid", error: "token" });
    expect(listCall).not.toHaveBeenCalled();
  });

  it("keeps a non-string stock code inside the try: a failure is an answer, never a throw", async () => {
    auth.mockResolvedValue({ user: { id: "u1" } });
    await expect(listBacktestTrades({ runId: 42, stockCode: 7 as unknown as string })).resolves.toEqual({ ok: false, reason: "invalid", error: "stock" });
  });

  it("answers unavailable when the API fails, and never throws to the page", async () => {
    auth.mockResolvedValue({ user: { id: "u1" } });
    listCall.mockRejectedValue(new Error("upstream"));
    await expect(listBacktestTrades({ runId: 42 })).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("never reads a cache: the list is per viewer", () => {
    const source = readFileSync(join(__dirname, "..", "backtestTrades.ts"), "utf8");
    expect(source).not.toMatch(/from "next\/cache"|unstable_cache|kv|redis/i);
    expect(source.startsWith('"use server"')).toBe(true);
  });
});
