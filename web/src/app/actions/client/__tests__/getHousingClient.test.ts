import { createClient } from "@connectrpc/connect";

import {
  getSuburbProfileClient,
  listAddressPriceDropsClient,
} from "../getHousingClient";

jest.mock("@connectrpc/connect", () => ({
  createClient: jest.fn(),
}));
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));

const mockCreateClient = createClient as jest.Mock;

/** What Connect throws when the store's 10 s deadline cancels the query. */
function internalError(): Error {
  return Object.assign(new Error("[internal] canceling statement due to statement timeout"), {
    code: 13,
    metadata: new Headers(),
  });
}

describe("listAddressPriceDropsClient", () => {
  beforeEach(() => {
    sessionStorage.clear();
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Measured 2026-10-21: the read failed `internal` at 10.2 s on every call,
  // and the board retried it three more times (four 10 s queries per visit).
  it("asks a failing address board once, and caches nothing", async () => {
    const listAddressPriceDrops = jest.fn().mockRejectedValue(internalError());
    mockCreateClient.mockReturnValue({ listAddressPriceDrops });

    await expect(listAddressPriceDropsClient("", 90, 50, "pct")).resolves.toBeUndefined();

    expect(listAddressPriceDrops).toHaveBeenCalledTimes(1);
    expect(sessionStorage.length).toBe(0);
  });

  it("returns and session-caches a board that answers", async () => {
    const response = { addresses: [{ addressKey: "a1" }] };
    const listAddressPriceDrops = jest.fn().mockResolvedValue(response);
    mockCreateClient.mockReturnValue({ listAddressPriceDrops });

    await expect(listAddressPriceDropsClient("VIC", 90, 50, "pct")).resolves.toBe(response);
    await expect(listAddressPriceDropsClient("VIC", 90, 50, "pct")).resolves.toEqual(response);

    expect(listAddressPriceDrops).toHaveBeenCalledTimes(1);
    expect(listAddressPriceDrops).toHaveBeenCalledWith({
      stateCode: "VIC",
      windowDays: 90,
      limit: 50,
      sort: "pct",
    });
  });
});

describe("the other housing reads", () => {
  beforeEach(() => {
    sessionStorage.clear();
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Only the address board is single-attempt: a fast read that blips still
  // gets its retry.
  it("still retry a transient failure", async () => {
    const getSuburbProfile = jest
      .fn()
      .mockRejectedValueOnce(internalError())
      .mockResolvedValue({ summary: { salCode: "20085" } });
    mockCreateClient.mockReturnValue({ getSuburbProfile });

    await expect(getSuburbProfileClient("20085")).resolves.toEqual({
      summary: { salCode: "20085" },
    });
    expect(getSuburbProfile).toHaveBeenCalledTimes(2);
  });
});
