import { QueryClient } from "@tanstack/react-query";
import { signOut } from "next-auth/react";
import { signOut as firebaseSignOut } from "firebase/auth";
import {
  clearFirebaseSession,
  clearUserSessionCaches,
  signOutFromBrowser,
} from "../auth-session";
import { getSessionCached, setSessionCached } from "../session-cache";

const mockAuthStateReady = jest.fn();
let mockAuth: { authStateReady: typeof mockAuthStateReady } | undefined;
const mockQueryClient = new QueryClient();

jest.mock("../firebase-client", () => ({
  get auth() {
    return mockAuth;
  },
}));
jest.mock("firebase/auth", () => ({ signOut: jest.fn() }));
jest.mock("../query-client", () => ({ getQueryClient: () => mockQueryClient }));

describe("browser authentication cleanup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthStateReady.mockResolvedValue(undefined);
    mockAuth = { authStateReady: mockAuthStateReady };
    jest.mocked(firebaseSignOut).mockResolvedValue(undefined);
    jest.mocked(signOut).mockResolvedValue(undefined);
    mockQueryClient.clear();
    localStorage.clear();
    sessionStorage.clear();
  });

  afterAll(() => mockQueryClient.clear());

  it("waits for restored Firebase authentication before clearing SDK persistence", async () => {
    let finishRestoring!: () => void;
    mockAuthStateReady.mockReturnValue(
      new Promise<void>((resolve) => {
        finishRestoring = resolve;
      }),
    );

    const cleanup = clearFirebaseSession();
    await Promise.resolve();
    await Promise.resolve();
    expect(firebaseSignOut).not.toHaveBeenCalled();

    finishRestoring();
    await cleanup;
    expect(firebaseSignOut).toHaveBeenCalledWith(mockAuth);
  });

  it("supports accounts without configured Firebase client authentication", async () => {
    mockAuth = undefined;
    await clearFirebaseSession();
    expect(firebaseSignOut).not.toHaveBeenCalled();
  });

  it("clears account data and developer tokens while retaining public caches and preferences", async () => {
    mockQueryClient.setQueryData(["subscription", "user-a"], {
      isPremium: true,
    });
    mockQueryClient.setQueryData(["dashboard", "list", "user-a"], ["private"]);
    mockQueryClient.setQueryData(["stock", "quote", "BHP"], { price: 42 });
    setSessionCached("portfolio:user-a", { holdings: ["BHP"] });
    setSessionCached("top-shorts:3m", { stocks: ["BHP"] });
    localStorage.setItem("shorted_api_token", "account-specific-token");
    localStorage.setItem("shorted:remembered-login", "account-metadata");

    await clearUserSessionCaches();

    expect(
      mockQueryClient.getQueryData(["subscription", "user-a"]),
    ).toBeUndefined();
    expect(
      mockQueryClient.getQueryData(["dashboard", "list", "user-a"]),
    ).toBeUndefined();
    expect(mockQueryClient.getQueryData(["stock", "quote", "BHP"])).toEqual({
      price: 42,
    });
    expect(getSessionCached("portfolio:user-a")).toBeNull();
    expect(getSessionCached("top-shorts:3m")).toEqual({ stocks: ["BHP"] });
    expect(localStorage.getItem("shorted_api_token")).toBeNull();
    expect(localStorage.getItem("shorted:remembered-login")).toBe(
      "account-metadata",
    );
  });

  it("leaves the new account's requests and data intact when switching accounts", async () => {
    mockQueryClient.setQueryData(["subscription", "user-a"], {
      isPremium: false,
    });
    mockQueryClient.setQueryData(["subscription", "user-b"], {
      isPremium: true,
    });
    mockQueryClient.setQueryData(
      ["dashboard", "list", "user-b"],
      ["new dashboard"],
    );

    await clearUserSessionCaches("user-a");

    expect(
      mockQueryClient.getQueryData(["subscription", "user-a"]),
    ).toBeUndefined();
    expect(mockQueryClient.getQueryData(["subscription", "user-b"])).toEqual({
      isPremium: true,
    });
    expect(
      mockQueryClient.getQueryData(["dashboard", "list", "user-b"]),
    ).toEqual(["new dashboard"]);
  });

  it("cancels an old account's request so a late response cannot repopulate its cache", async () => {
    let finishRequest!: (value: string) => void;
    const request = mockQueryClient
      .fetchQuery({
        queryKey: ["subscription", "user-a"],
        queryFn: () =>
          new Promise<string>((resolve) => {
            finishRequest = resolve;
          }),
      })
      .catch(() => undefined);

    await clearUserSessionCaches();
    finishRequest("old account response");
    await request;
    expect(
      mockQueryClient.getQueryData(["subscription", "user-a"]),
    ).toBeUndefined();
  });

  it("deduplicates sign-out and waits for local cleanup before redirecting", async () => {
    let finishFirebaseSignOut!: () => void;
    jest.mocked(firebaseSignOut).mockReturnValue(
      new Promise<void>((resolve) => {
        finishFirebaseSignOut = resolve;
      }),
    );

    const first = signOutFromBrowser();
    const second = signOutFromBrowser();
    expect(second).toBe(first);
    // Let both lazy imports and auth restoration finish.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(signOut).not.toHaveBeenCalled();

    finishFirebaseSignOut();
    await Promise.all([first, second]);
    expect(firebaseSignOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ callbackUrl: "/" });
  });

  it("still signs out the server session if browser persistence cleanup fails", async () => {
    jest
      .mocked(firebaseSignOut)
      .mockRejectedValueOnce(new Error("Storage unavailable"));
    await signOutFromBrowser();
    expect(signOut).toHaveBeenCalledWith({ callbackUrl: "/" });
  });

  it("still signs out the server session if Firebase restoration fails", async () => {
    mockAuthStateReady.mockRejectedValueOnce(
      new Error("SDK restoration failed"),
    );
    await signOutFromBrowser();
    expect(firebaseSignOut).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledWith({ callbackUrl: "/" });
  });

  it("propagates SDK cleanup failures when clearing Firebase directly", async () => {
    jest
      .mocked(firebaseSignOut)
      .mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(clearFirebaseSession()).rejects.toThrow("Storage unavailable");
    expect(signOut).not.toHaveBeenCalled();
  });

  it("allows a retry when server sign-out fails", async () => {
    jest
      .mocked(signOut)
      .mockRejectedValueOnce(new Error("Network unavailable"));
    await expect(signOutFromBrowser()).rejects.toThrow("Network unavailable");
    await signOutFromBrowser();
    expect(signOut).toHaveBeenCalledTimes(2);
  });
});
