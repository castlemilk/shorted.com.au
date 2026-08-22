import {
  getSyncValidation,
  normalizeStockInput,
  startSyncValidation,
} from "../validateSync";

jest.mock("~/server/admin", () => ({
  requireAdmin: jest.fn(async () => ({ email: "ben@shorted.com.au" })),
}));

jest.mock("../config", () => ({
  SHORTS_API_URL: "https://api.test",
}));

describe("normalizeStockInput", () => {
  it("splits, upper-cases and de-duplicates", async () => {
    expect(await normalizeStockInput(" bhp, dro  4dx;bhp ")).toEqual({
      codes: ["BHP", "DRO", "4DX"],
    });
  });

  it("refuses anything that is not a product code", async () => {
    const { error } = await normalizeStockInput("BHP, --shadow=false");
    expect(error).toBeTruthy();
  });

  it("refuses an empty list and an oversized one", async () => {
    expect((await normalizeStockInput("   ")).error).toBeTruthy();
    const many = Array.from({ length: 21 }, (_, i) => `A${i}`).join(",");
    expect((await normalizeStockInput(many)).error).toMatch(/max 20/);
  });
});

describe("startSyncValidation", () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  it("posts ONLY the stock list and returns the execution", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        executionName: "shorts-data-sync-v4l1d",
        args: ["short-data-sync", "-shadow", "-stocks", "BHP,DRO"],
        stocks: ["BHP", "DRO"],
      }),
    });

    const res = await startSyncValidation({ stocks: ["BHP", "DRO"] });

    expect(res.ok).toBe(true);
    expect(res.executionName).toBe("shorts-data-sync-v4l1d");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // The body carries stock codes and nothing else — no job, no args, no
    // region. The backend constructs the argv; this action cannot influence it.
    expect(JSON.parse(init.body as string)).toEqual({ stocks: ["BHP", "DRO"] });
    expect((init.headers as Record<string, string>)["x-admin-actor"]).toBe(
      "ben@shorted.com.au",
    );
  });

  // The validation window is the ONE extra thing the body may carry. Omitted,
  // it must not appear at all (the job's default stays authoritative); supplied,
  // it is an integer and is capped before it is sent.
  it("sends the window only when asked, and caps it", async () => {
    const post = async (days?: number) => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ executionName: "e" }),
      });
      await startSyncValidation({ stocks: ["BHP"], days });
      const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
      return JSON.parse(init.body as string) as Record<string, unknown>;
    };

    expect(await post()).toEqual({ stocks: ["BHP"] });
    expect(await post(14)).toEqual({ stocks: ["BHP"], days: 14 });
    expect(await post(9999)).toEqual({ stocks: ["BHP"], days: 30 });
    expect(await post(0)).toEqual({ stocks: ["BHP"] });
  });

  it("surfaces a backend refusal code", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_stocks", message: "nope" }),
    });
    const res = await startSyncValidation({ stocks: ["!!"] });
    expect(res).toMatchObject({ ok: false, code: "invalid_stocks", message: "nope" });
  });

  it("never retries a failed POST", async () => {
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));
    const res = await startSyncValidation({ stocks: ["BHP"] });
    expect(res.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("getSyncValidation", () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  it("treats a still-running execution as a successful poll", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ status: "running" }) });
    const res = await getSyncValidation("shorts-data-sync-v4l1d");
    expect(res).toMatchObject({ ok: true, status: "running" });
    expect(res.summary).toBeUndefined();
  });

  it("returns the parsed summary once complete", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: "succeeded",
        summary: {
          mode: "shadow",
          schema_version: 1,
          rows_parsed: 2100,
          stocks: { requested: ["BHP"], not_found: [], observations: [], counts: {} },
        },
      }),
    });
    const res = await getSyncValidation("shorts-data-sync-v4l1d");
    expect(res.summary?.stocks?.requested).toEqual(["BHP"]);
  });

  it("surfaces summary_not_found with the log tail", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({
        error: "summary_not_found",
        message: "no summary",
        logTail: ["done"],
      }),
    });
    const res = await getSyncValidation("shorts-data-sync-v4l1d");
    expect(res).toMatchObject({ ok: false, code: "summary_not_found" });
    expect(res.logTail).toEqual(["done"]);
  });

  it("url-encodes the execution name", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ status: "running" }) });
    await getSyncValidation("a b/c");
    expect(fetchMock.mock.calls[0][0]).toContain("execution=a%20b%2Fc");
  });
});
